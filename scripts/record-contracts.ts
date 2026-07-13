/**
 * Contract recorder — re-records all fixture files against real APIs.
 *
 * Run nightly in CI (.github/workflows/contracts-canary.yml) or manually:
 *
 *   STRIPE_TEST_SECRET_KEY=sk_test_... \
 *   ANTHROPIC_API_KEY_TEST=sk-ant-... \
 *   pnpm tsx scripts/record-contracts.ts
 *
 * For each fixture in tests/contracts/fixtures/<provider>/<resource>/<name>.json:
 *   1. Read the request shape (method, url, body).
 *   2. Substitute placeholder IDs from prior steps' captured responses.
 *   3. Replay the request against the real API.
 *   4. Write the response back to fixture.response.
 *   5. Preserve fixture._note.
 *
 * Stripe is orchestrated as a session (customer → subscription → cancel;
 * account → account_link) because subscription/cancel/link fixtures
 * reference placeholder IDs that must be substituted with real values
 * captured from earlier calls. Anthropic fixtures are independent.
 *
 * Cleanup: subscriptions created during recording are cancelled at the
 * end so they don't accumulate in Stripe test mode. Customers and
 * Connect accounts are left (they cost nothing and test-mode pollution
 * is fine).
 *
 * Failure modes:
 *   • Missing secret → fail at startup, before any API call
 *   • Real API non-2xx → log full body, exit 1 (the canary workflow's
 *     diff step won't run, so no false-positive "no drift" result)
 *   • Mid-session orchestration failure → still attempt cleanup on the
 *     IDs we managed to capture before bailing
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { redactSecrets } from "./lib/redact-secrets";
import { stripeFormEncode } from "./lib/stripe-form-encode";
import {
  substitutePlaceholders,
  type Substitutions,
} from "./lib/substitute-placeholders";

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const FIXTURES_ROOT = path.join(REPO_ROOT, "tests/contracts/fixtures");

interface Fixture {
  _note?: string;
  request: {
    method: string;
    url: string;
    body?: Record<string, unknown>;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
}

const STRIPE_KEY = process.env.STRIPE_TEST_SECRET_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY_TEST;

if (!STRIPE_KEY || !ANTHROPIC_KEY) {
  console.error(
    "Error: STRIPE_TEST_SECRET_KEY and ANTHROPIC_API_KEY_TEST must be set.",
  );
  process.exit(1);
}

function readFixture(relPath: string): Fixture {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURES_ROOT, relPath), "utf8"),
  ) as Fixture;
}

function writeFixture(relPath: string, fixture: Fixture): void {
  fs.writeFileSync(
    path.join(FIXTURES_ROOT, relPath),
    JSON.stringify(fixture, null, 2) + "\n",
  );
}

async function stripeFetch(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`https://api.stripe.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body ? stripeFormEncode(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Stripe ${method} ${endpoint} failed: ${res.status} ${text}`,
    );
  }
  return { status: res.status, body: JSON.parse(text) as unknown };
}

async function anthropicFetch(
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY as string,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Anthropic POST /v1/messages failed: ${res.status} ${text}`);
  }
  return { status: res.status, body: JSON.parse(text) as unknown };
}

// Stripe Price lookup key. Reused across runs so we don't accumulate
// prices. If absent, we create one at the start of each session.
const CANARY_PRICE_LOOKUP_KEY = "contracts_canary_test_price";

async function ensureCanaryPrice(): Promise<string> {
  const search = await stripeFetch(
    "GET",
    `/v1/prices/search?query=${encodeURIComponent(
      `lookup_key:"${CANARY_PRICE_LOOKUP_KEY}"`,
    )}`,
  );
  const found = (search.body as { data?: Array<{ id: string }> }).data ?? [];
  if (found.length > 0 && found[0]?.id) return found[0].id;

  const product = await stripeFetch("POST", "/v1/products", {
    name: "Contracts Canary Test Plan",
  });
  const productId = (product.body as { id: string }).id;

  const price = await stripeFetch("POST", "/v1/prices", {
    product: productId,
    unit_amount: 1000,
    currency: "usd",
    recurring: { interval: "month" },
    lookup_key: CANARY_PRICE_LOOKUP_KEY,
  });
  return (price.body as { id: string }).id;
}

async function recordStripeFixtures(): Promise<void> {
  console.log("Stripe: ensuring canary test price exists...");
  const priceId = await ensureCanaryPrice();
  console.log(`Stripe: using price ${priceId}`);

  const subs: Substitutions = {
    price_test_placeholder: priceId,
  };

  const createdSubscriptionIds: string[] = [];

  try {
    {
      const fixture = readFixture("stripe/customers/create-success.json");
      const body = substitutePlaceholders(fixture.request.body ?? {}, subs);
      const { status, body: respBody } = await stripeFetch(
        "POST",
        "/v1/customers",
        body,
      );
      subs.cus_test_placeholder = (respBody as { id: string }).id;
      writeFixture("stripe/customers/create-success.json", {
        ...fixture,
        response: { status, headers: { "content-type": "application/json" }, body: respBody },
      });
      console.log(`Stripe: customer ${subs.cus_test_placeholder}`);
    }

    {
      // Attach Stripe's built-in test card to the freshly-created customer and
      // set it as the invoice default so the subscription create below succeeds.
      // pm_card_visa is a Stripe-provided test payment method ID that is always
      // available in test mode — no fixture is recorded for this setup step.
      const customerId = subs.cus_test_placeholder as string;
      await stripeFetch("POST", `/v1/payment_methods/pm_card_visa/attach`, {
        customer: customerId,
      });
      await stripeFetch("POST", `/v1/customers/${customerId}`, {
        invoice_settings: { default_payment_method: "pm_card_visa" },
      });
      console.log(`Stripe: attached test payment method to ${customerId}`);
    }

    {
      const fixture = readFixture("stripe/subscriptions/create-success.json");
      const body = substitutePlaceholders(fixture.request.body ?? {}, subs);
      const { status, body: respBody } = await stripeFetch(
        "POST",
        "/v1/subscriptions",
        body,
      );
      const subId = (respBody as { id: string }).id;
      subs.sub_test_placeholder = subId;
      createdSubscriptionIds.push(subId);
      writeFixture("stripe/subscriptions/create-success.json", {
        ...fixture,
        response: { status, headers: { "content-type": "application/json" }, body: respBody },
      });
      console.log(`Stripe: subscription ${subId}`);
    }

    {
      const fixture = readFixture("stripe/subscriptions/cancel-success.json");
      const subId = subs.sub_test_placeholder;
      const { status, body: respBody } = await stripeFetch(
        "DELETE",
        `/v1/subscriptions/${subId}`,
      );
      const idx = createdSubscriptionIds.indexOf(subId);
      if (idx !== -1) createdSubscriptionIds.splice(idx, 1);
      writeFixture("stripe/subscriptions/cancel-success.json", {
        ...fixture,
        response: { status, headers: { "content-type": "application/json" }, body: respBody },
      });
      console.log(`Stripe: subscription cancelled`);
    }

    {
      const fixture = readFixture("stripe/connect/account-create-success.json");
      const body = substitutePlaceholders(fixture.request.body ?? {}, subs);
      const { status, body: respBody } = await stripeFetch(
        "POST",
        "/v1/accounts",
        body,
      );
      subs.acct_test_placeholder = (respBody as { id: string }).id;
      writeFixture("stripe/connect/account-create-success.json", {
        ...fixture,
        response: { status, headers: { "content-type": "application/json" }, body: respBody },
      });
      console.log(`Stripe: connect account ${subs.acct_test_placeholder}`);
    }

    {
      const fixture = readFixture(
        "stripe/connect/onboarding-link-create-success.json",
      );
      const body = substitutePlaceholders(fixture.request.body ?? {}, subs);
      const { status, body: respBody } = await stripeFetch(
        "POST",
        "/v1/account_links",
        body,
      );
      writeFixture("stripe/connect/onboarding-link-create-success.json", {
        ...fixture,
        response: { status, headers: { "content-type": "application/json" }, body: respBody },
      });
      console.log(`Stripe: onboarding link created`);
    }
  } finally {
    for (const subId of createdSubscriptionIds) {
      try {
        await stripeFetch("DELETE", `/v1/subscriptions/${subId}`);
      } catch (err) {
        // Stranded test-mode subscription. The original error already
        // propagated; surfacing this as `error` (not `warn`) so log
        // tailers / Vercel surfaces flag it as a real condition that
        // accumulates if it recurs nightly.
        console.error(
          `Stripe cleanup: failed to cancel ${subId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

// Every Anthropic fixture under anthropic/chat/ must hit the same chat
// endpoint. Asserting here makes a future divergence (someone adds a
// fixture under anthropic/embeddings/ but reuses this recorder) fail
// loudly with a clear message instead of silently mis-replaying.
const ANTHROPIC_CHAT_ENDPOINT = "https://api.anthropic.com/v1/messages";

async function recordAnthropicFixtures(): Promise<void> {
  const dir = path.join(FIXTURES_ROOT, "anthropic/chat");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const relPath = `anthropic/chat/${file}`;
    const fixture = readFixture(relPath);
    if (fixture.request.method !== "POST" || fixture.request.url !== ANTHROPIC_CHAT_ENDPOINT) {
      throw new Error(
        `${relPath}: expected POST ${ANTHROPIC_CHAT_ENDPOINT}, got ` +
          `${fixture.request.method} ${fixture.request.url}. ` +
          `Add a new recorder branch if this is intentional.`,
      );
    }
    const { status, body: respBody } = await anthropicFetch(fixture.request.body ?? {});
    writeFixture(relPath, {
      ...fixture,
      response: { status, headers: { "content-type": "application/json" }, body: respBody },
    });
    console.log(`Anthropic: ${file}`);
  }
}

async function main(): Promise<void> {
  console.log("Recording contract fixtures...");
  await recordStripeFixtures();
  await recordAnthropicFixtures();
  console.log("Done.");
}

main().catch((err: unknown) => {
  console.error(redactSecrets(err));
  process.exit(1);
});
