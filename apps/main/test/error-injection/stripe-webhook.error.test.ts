// Tier 1 — Stripe webhook handler error-injection coverage.
//
// The pre-existing `apps/main/test/unit/stripe/webhook-error-propagation.test.ts`
// already covers Pattern 1 (DB error injection) for every fixed event branch.
// This file adds the two injection modes that test didn't cover:
//
//   1. Resource-unavailable injection — Stripe SDK throws on
//      constructEvent. Handler must return 400 (signature error path),
//      not 500 silently swallow.
//   2. Concurrent execution — same webhook event arrives twice in
//      parallel. Idempotency unique-constraint must keep only one
//      copy alive; the other returns 200 ("Duplicate") not 500.
//
// Pattern 1 coverage stays in apps/main/test/unit/stripe/ alongside the
// fix that closed it; this file owns the resource-down + concurrency lanes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Behavior toggles. Names prefixed with `mock` so vitest's vi.mock factory
// hoist-safety static check allows the closures below to reference them.
let mockInsertResult: { error: { code?: string; message: string } | null } = { error: null };
let mockEventType = "transfer.paid";
let mockEventData: Record<string, unknown> = { id: "tr_1" };
let mockConstructEventThrows = false;
let mockInsertCallCount = 0;
let mockArraySelectResult: { data: unknown[]; error: { message: string } | null } = { data: [{ id: "p-1" }], error: null };
let mockMaybeSingleResult: { data: unknown; error: { message: string } | null } = {
  data: { id: "t-1", non_paying_since: null, onboarding_stage: "subscription", subscription_status: null },
  error: null,
};

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(_table: string) {
      void _table;
      return {
        async insert(_payload: unknown) {
          void _payload;
          mockInsertCallCount += 1;
          // Simulate UNIQUE-violation on the 2nd insert when running the
          // parallel-delivery test (first insert wins, second sees 23505).
          return mockInsertResult;
        },
        select(_cols: string) {
          void _cols;
          const chain: Record<string, unknown> = {
            eq() { return chain; },
            in() { return chain; },
            async maybeSingle() { return mockMaybeSingleResult; },
            async single() { return mockMaybeSingleResult; },
            then(resolve: (v: { data: unknown[]; error: { message: string } | null }) => unknown) {
              return resolve(mockArraySelectResult);
            },
          };
          return chain;
        },
        update(_payload: unknown) {
          void _payload;
          const u: Record<string, unknown> = {
            eq() { return u; },
            in() { return u; },
            then(resolve: (v: { data: null; error: null }) => unknown) {
              return resolve({ data: null, error: null });
            },
          };
          return u;
        },
      };
    },
  }),
}));

vi.mock("stripe", () => ({
  default: class FakeStripe {
    webhooks = {
      constructEvent: (_body: string, _sig: string, _secret: string) => {
        void _body; void _sig; void _secret;
        if (mockConstructEventThrows) {
          throw new Error("synthetic signature verification failure");
        }
        return {
          id: `evt_test_${mockEventType}`,
          type: mockEventType,
          data: { object: mockEventData },
        };
      },
    };
    errors = {
      StripeError: class StripeError extends Error {},
    };
  },
}));

import { handleStripeWebhook } from "@/lib/stripe/webhook-handler";

function makeReq(): Request {
  return new Request("https://example.com/api/webhooks/stripe/platform", {
    method: "POST",
    headers: { "stripe-signature": "fake" },
    body: JSON.stringify({ type: mockEventType }),
  });
}

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_fake_connect";
  mockEventType = "transfer.paid";
  mockEventData = { id: "tr_1" };
  mockInsertResult = { error: null };
  mockConstructEventThrows = false;
  mockInsertCallCount = 0;
  mockArraySelectResult = { data: [{ id: "p-1" }], error: null };
  mockMaybeSingleResult = {
    data: { id: "t-1", non_paying_since: null, onboarding_stage: "subscription", subscription_status: null },
    error: null,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Stripe webhook — resource-unavailable injection (Pattern 2)", () => {
  it("returns 400 when Stripe SDK signature verification throws (fails closed on bad sig)", async () => {
    mockConstructEventThrows = true;
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(400);
  });

  it("returns 500 when stripe_webhook_events insert hits a non-23505 DB error (fails closed)", async () => {
    mockInsertResult = { error: { code: "08000", message: "synthetic connection error" } };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(500);
  });

  it("returns 500 when env STRIPE_SECRET_KEY missing (fails closed on config gap)", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(500);
  });
});

describe("Stripe webhook — concurrency / idempotency (Pattern 6)", () => {
  it("returns 200 ('Duplicate') when stripe_webhook_events insert hits 23505 unique-violation", async () => {
    // Stripe re-delivers a webhook → second insert hits the unique constraint
    // on stripe_event_id. Handler must short-circuit to 200 so Stripe stops
    // retrying without processing the side-effect twice.
    mockInsertResult = { error: { code: "23505", message: "duplicate key value" } };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Duplicate");
  });

  it("parallel webhook deliveries: first call succeeds (200 'OK'), second hits 23505 (200 'Duplicate')", async () => {
    // Greptile review fix: the prior version drove insert behavior via the
    // module-scoped mockInsertResult, which two concurrent IIFEs could
    // overwrite before either insert call fired — so both calls could see
    // the 23505 result and the test would pass for the wrong reason.
    //
    // Sequence-driven mock: the Nth insert call returns the Nth result,
    // independent of when each IIFE began. Body-text assertion proves
    // exactly one call processed and one deduped — a regression that
    // breaks happy-path inserts (both deduped) would now fail.
    const insertSequence: Array<{ error: { code?: string; message: string } | null }> = [
      { error: null },
      { error: { code: "23505", message: "duplicate" } },
    ];
    let sequencedInsertCount = 0;

    vi.spyOn(await import("@/lib/db/service-role-client"), "createServiceRoleClient").mockImplementation(
      () => ({
        from(_table: string) {
          void _table;
          return {
            async insert(_payload: unknown) {
              void _payload;
              const idx = sequencedInsertCount;
              sequencedInsertCount += 1;
              return insertSequence[idx] ?? insertSequence[insertSequence.length - 1]!;
            },
            select() {
              const chain: Record<string, unknown> = {
                eq() { return chain; },
                in() { return chain; },
                async maybeSingle() {
                  return {
                    data: { id: "t-1", non_paying_since: null, onboarding_stage: "subscription", subscription_status: null },
                    error: null,
                  };
                },
                async single() { return { data: { id: "t-1" }, error: null }; },
                then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
                  return resolve({ data: [{ id: "p-1" }], error: null });
                },
              };
              return chain;
            },
            update() {
              const u: Record<string, unknown> = {
                eq() { return u; },
                in() { return u; },
                then(resolve: (v: { data: null; error: null }) => unknown) {
                  return resolve({ data: null, error: null });
                },
              };
              return u;
            },
          };
        },
      } as never),
    );

    const [a, b] = await Promise.all([
      handleStripeWebhook(makeReq(), "platform"),
      handleStripeWebhook(makeReq(), "platform"),
    ]);
    expect(sequencedInsertCount).toBe(2);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const bodies = [await a.text(), await b.text()];
    expect(bodies).toContain("OK");
    expect(bodies).toContain("Duplicate");
  });
});
