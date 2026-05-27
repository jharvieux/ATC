// D-091 P1 #1 — Stripe webhook MUST return non-200 when a DB mutation fails.
//
// Pre-fix: every `await db.from(...).update(...).eq(...)` discarded its
// { error } tuple. A DB-level failure (network, RLS, etc.) silently left
// state un-updated while the handler still returned 200 to Stripe. Stripe
// stops retrying on 200, so the failure was permanent.
//
// Post-fix: every update destructures { error } and throws on truthy
// error; the outer try/catch sets processingOutcome='error' and the
// handler returns 500 → Stripe retries.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We need to mock both the Stripe SDK (signature verification) and the
// Supabase service-role client. The mocks live at the module level so
// the dynamic-import-aware webhook-handler picks them up.

interface DbBehavior {
  insertResult: { error: { code?: string; message: string } | null };
  selectResult: Record<string, { data: unknown; error: { message: string } | null }>;
  updateResult: { data: unknown; error: { message: string } | null };
}

let dbBehavior: DbBehavior;
let updateCallCount = 0;

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(_table: string) {
      return {
        async insert() { return dbBehavior.insertResult; },
        select(_cols: string) {
          const chain = {
            eq() { return chain; },
            async maybeSingle() {
              return dbBehavior.selectResult["maybeSingle"] ?? { data: null, error: null };
            },
            async single() {
              return dbBehavior.selectResult["single"] ?? { data: null, error: null };
            },
            then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
              return resolve({ data: (dbBehavior.selectResult["array"]?.data as unknown[]) ?? [], error: null });
            },
          };
          return chain;
        },
        update(_payload: unknown) {
          updateCallCount += 1;
          const chain = {
            eq() { return chain; },
            in() { return chain; },
            then(resolve: (v: { data: unknown; error: { message: string } | null }) => unknown) {
              return resolve(dbBehavior.updateResult);
            },
          };
          return chain;
        },
      };
    },
  }),
}));

// Stripe SDK mock — returns a synthetic event for the test, no real signature.
vi.mock("stripe", () => {
  return {
    default: class FakeStripe {
      webhooks = {
        constructEvent: (_body: string, _sig: string, _secret: string) => ({
          id: "evt_test_1",
          type: "customer.subscription.updated",
          data: {
            object: {
              id: "sub_test_1",
              status: "active",
            },
          },
        }),
      };
      errors = {
        StripeError: class StripeError extends Error {},
      };
    },
  };
});

import { handleStripeWebhook } from "@/lib/stripe/webhook-handler";

function makeRequest(): Request {
  return new Request("https://example.com/api/webhooks/stripe/platform", {
    method: "POST",
    headers: { "stripe-signature": "fake" },
    body: JSON.stringify({ type: "customer.subscription.updated", id: "evt_test_1" }),
  });
}

beforeEach(() => {
  updateCallCount = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_fake_connect";
  dbBehavior = {
    insertResult: { error: null },
    selectResult: {
      maybeSingle: { data: { id: "t-1", non_paying_since: null }, error: null },
    },
    updateResult: { data: null, error: null },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Stripe webhook — D-091 P1 #1 error propagation", () => {
  it("returns 200 on successful update (regression-baseline)", async () => {
    const res = await handleStripeWebhook(makeRequest(), "platform");
    expect(res.status).toBe(200);
  });

  it("returns 500 when DB update fails (PRE-FIX returned 200 silently)", async () => {
    dbBehavior.updateResult = {
      data: null,
      error: { message: "synthetic DB error" },
    };
    const res = await handleStripeWebhook(makeRequest(), "platform");
    expect(res.status).toBe(500);
    // The update call still happened — we just refused to declare success.
    expect(updateCallCount).toBeGreaterThan(0);
  });

  it("returns 200 on duplicate event (idempotency dedup)", async () => {
    dbBehavior.insertResult = { error: { code: "23505", message: "duplicate key" } };
    const res = await handleStripeWebhook(makeRequest(), "platform");
    expect(res.status).toBe(200);
  });
});
