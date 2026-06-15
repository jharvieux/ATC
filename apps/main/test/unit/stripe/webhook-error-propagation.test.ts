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
            then(resolve: (v: { data: unknown[] | null; error: { message: string } | null }) => unknown) {
              const arrayErr = dbBehavior.selectResult["array"]?.error ?? null;
              return resolve({
                data: arrayErr ? null : ((dbBehavior.selectResult["array"]?.data as unknown[]) ?? []),
                error: arrayErr,
              });
            },
          };
          return chain;
        },
        update(_payload: unknown) {
          updateCallCount += 1;
          const chain = {
            eq() { return chain; },
            in() { return chain; },
            // transfer.reversed settles via .update().eq().eq().select("id");
            // tenant updates resolve the chain directly via .then().
            select(_cols: string) {
              void _cols;
              return {
                then(resolve: (v: { data: unknown; error: { message: string } | null }) => unknown) {
                  return resolve(dbBehavior.updateResult);
                },
              };
            },
            then(resolve: (v: { data: unknown; error: { message: string } | null }) => unknown) {
              return resolve(dbBehavior.updateResult);
            },
          };
          return chain;
        },
        delete() {
          const chain = {
            eq() {
              return {
                then(resolve: (v: { data: null; error: null }) => unknown) {
                  return resolve({ data: null, error: null });
                },
              };
            },
          };
          return chain;
        },
      };
    },
  }),
}));

// Stripe SDK mock — returns a synthetic event whose type/data are
// controlled by a module-scoped variable so each test exercises the
// specific handler branch it cares about. (Greptile review feedback —
// without this, all tests would only hit customer.subscription.updated.)
let mockEventType = "customer.subscription.updated";
let mockEventData: Record<string, unknown> = { id: "sub_test_1", status: "active" };

vi.mock("stripe", () => {
  return {
    default: class FakeStripe {
      webhooks = {
        constructEvent: (_body: string, _sig: string, _secret: string) => ({
          id: `evt_test_${mockEventType}`,
          type: mockEventType,
          data: {
            object: mockEventData,
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
    body: JSON.stringify({ type: mockEventType, id: `evt_test_${mockEventType}` }),
  });
}

beforeEach(() => {
  updateCallCount = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_fake_connect";
  // Default mock event = customer.subscription.updated. Individual
  // tests override via setEvent() to exercise each fixed handler branch.
  mockEventType = "customer.subscription.updated";
  mockEventData = { id: "sub_test_1", status: "active" };
  dbBehavior = {
    insertResult: { error: null },
    selectResult: {
      maybeSingle: { data: { id: "t-1", non_paying_since: null, onboarding_stage: "subscription", subscription_status: null }, error: null },
    },
    updateResult: { data: null, error: null },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setEvent(type: string, data: Record<string, unknown>): void {
  mockEventType = type;
  mockEventData = data;
}

// Each entry covers a single fixed handler branch. `prep` runs per-test to
// configure the DB mock so the handler actually reaches its update call.
// Greptile review noted the prior test only exercised
// customer.subscription.updated; this fan-out closes that gap.
const FIXED_HANDLER_EVENTS: Array<{
  type: string;
  data: Record<string, unknown>;
  prep?: () => void;
}> = [
  {
    // transfer.reversed settles via .update().eq().eq().select("id") — its DB
    // error surfaces through the update chain, not a pre-SELECT.
    type: "transfer.reversed",
    data: { id: "tr_1" },
  },
  {
    type: "checkout.session.completed",
    data: { id: "cs_1", subscription: "sub_1", customer: "cus_1", metadata: { tenant_id: "t-1" } },
  },
  {
    type: "account.updated",
    data: { id: "acct_1", details_submitted: true, payouts_enabled: false },
    // account.updated needs tenant.onboarding_stage to match a branch.
    prep: () => {
      dbBehavior.selectResult["maybeSingle"] = { data: { id: "t-1", onboarding_stage: "tax_form" }, error: null };
    },
  },
  { type: "customer.subscription.created", data: { id: "sub_1", status: "active" } },
  { type: "customer.subscription.updated", data: { id: "sub_1", status: "active" } },
  { type: "customer.subscription.deleted", data: { id: "sub_1", status: "canceled" } },
  { type: "invoice.payment_succeeded", data: { parent: { subscription_details: { subscription: "sub_1" } } } },
  { type: "invoice.payment_failed", data: { parent: { subscription_details: { subscription: "sub_1" } } } },
];

describe("Stripe webhook — D-091 P1 #1 error propagation", () => {
  it("returns 200 on successful update (baseline)", async () => {
    const res = await handleStripeWebhook(makeRequest(), "platform");
    expect(res.status).toBe(200);
  });

  it("returns 200 on duplicate event (idempotency dedup)", async () => {
    dbBehavior.insertResult = { error: { code: "23505", message: "duplicate key" } };
    dbBehavior.selectResult["maybeSingle"] = {
      data: { processing_completed_at: "2026-06-06T10:00:00Z", processing_outcome: "success" },
      error: null,
    };
    const res = await handleStripeWebhook(makeRequest(), "platform");
    expect(res.status).toBe(200);
  });

  // Greptile review #262 — exercise every fixed handler branch under
  // injected DB error and assert 500 propagation. Pre-fix any of these
  // would silently return 200 and Stripe would stop retrying.
  for (const { type, data, prep } of FIXED_HANDLER_EVENTS) {
    it(`returns 500 when DB update fails on ${type}`, async () => {
      setEvent(type, data);
      prep?.();
      dbBehavior.updateResult = {
        data: null,
        error: { message: `synthetic DB error on ${type}` },
      };
      const res = await handleStripeWebhook(makeRequest(), "platform");
      expect(res.status, `${type} should return 500 on DB failure`).toBe(500);
      expect(updateCallCount, `${type} should have attempted at least one update`).toBeGreaterThan(0);
    });
  }

  // #717 — SELECT errors on tenant lookups must also propagate as 500.
  // Pre-fix: error field was discarded; handler silently skipped the event.
  const SELECT_ERROR_EVENTS: Array<{ type: string; data: Record<string, unknown> }> = [
    {
      type: "checkout.session.completed",
      data: { id: "cs_1", subscription: "sub_1", customer: "cus_1", metadata: { tenant_id: "t-1" } },
    },
    { type: "account.updated", data: { id: "acct_1", details_submitted: true, payouts_enabled: false } },
    { type: "customer.subscription.updated", data: { id: "sub_1", status: "active" } },
    { type: "invoice.payment_succeeded", data: { parent: { subscription_details: { subscription: "sub_1" } } } },
    { type: "invoice.payment_failed", data: { parent: { subscription_details: { subscription: "sub_1" } } } },
  ];

  for (const { type, data } of SELECT_ERROR_EVENTS) {
    it(`#717: returns 500 when tenant SELECT fails on ${type}`, async () => {
      setEvent(type, data);
      dbBehavior.selectResult["maybeSingle"] = {
        data: null,
        error: { message: `synthetic SELECT error on ${type}` },
      };
      const res = await handleStripeWebhook(makeRequest(), "platform");
      expect(res.status, `${type} SELECT error should return 500`).toBe(500);
    });
  }
});
