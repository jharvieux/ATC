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
let mockEventType = "transfer.reversed";
let mockEventData: Record<string, unknown> = { id: "tr_1" };
let mockConstructEventThrows = false;
let mockInsertCallCount = 0;
let mockDeleteCallCount = 0;
let mockArraySelectResult: { data: unknown[]; error: { message: string } | null } = { data: [{ id: "p-1" }], error: null };
// [review gap-fill #719] result of the transfer.reversed `.update(...).eq().eq().select("id")`
// chain — lets a test drive the handler into outcome='error' to exercise Step 5's clear.
let mockUpdateSelectResult: { data: unknown[] | null; error: { message: string } | null } = { data: [{ id: "p-1" }], error: null };
// Result returned by db.rpc() — default data=1 (one row processed). Override to inject errors
// into the process_transfer_reversal RPC path.
let mockRpcResult: { data: unknown; error: { message: string } | null } = { data: 1, error: null };
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
            select() {
              return {
                then(resolve: (v: { data: unknown[] | null; error: { message: string } | null }) => unknown) {
                  return resolve(mockUpdateSelectResult);
                },
              };
            },
            then(resolve: (v: { data: null; error: null }) => unknown) {
              return resolve({ data: null, error: null });
            },
          };
          return u;
        },
        delete() {
          const d: Record<string, unknown> = {
            eq() {
              mockDeleteCallCount += 1;
              return {
                then(resolve: (v: { data: null; error: null }) => unknown) {
                  return resolve({ data: null, error: null });
                },
              };
            },
          };
          return d;
        },
      };
    },
    async rpc(fn: string, _args?: unknown) {
      void _args;
      if (fn !== "process_transfer_reversal") throw new Error(`Unexpected rpc: ${fn}`);
      return mockRpcResult;
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
  mockEventType = "transfer.reversed";
  mockEventData = { id: "tr_1" };
  mockInsertResult = { error: null };
  mockConstructEventThrows = false;
  mockInsertCallCount = 0;
  mockDeleteCallCount = 0;
  mockArraySelectResult = { data: [{ id: "p-1" }], error: null };
  mockUpdateSelectResult = { data: [{ id: "p-1" }], error: null };
  mockRpcResult = { data: 1, error: null };
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

describe("Stripe webhook — transfer.reversed delta guard (Pattern 2)", () => {
  it("returns 200 'OK' when transfer.reversed delta is zero (re-delivery, same amount_reversed) — guard skips RPC", async () => {
    // delta = amount_reversed(0) - previous_attributes(absent→0) = 0
    // Guard fires → break → processingOutcome stays 'unhandled' → 200 "OK"
    // Without the guard: db.rpc() is not in the top-level mock → throws → handler catches → 500.
    // A regression removing the guard changes this from 200 to 500.
    mockEventType = "transfer.reversed";
    mockEventData = { id: "tr_1", amount_reversed: 0 };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });
});

describe("Stripe webhook — concurrency / idempotency (Pattern 6)", () => {
  it("returns 200 ('Duplicate') when stripe_webhook_events insert hits 23505 unique-violation", async () => {
    // Stripe re-delivers a webhook → second insert hits the unique constraint
    // on stripe_event_id. If the prior attempt completed, the handler must
    // short-circuit to 200 so Stripe stops retrying without processing twice.
    mockInsertResult = { error: { code: "23505", message: "duplicate key value" } };
    mockMaybeSingleResult = {
      data: { processing_completed_at: "2026-06-06T10:00:00Z", processing_outcome: "success" },
      error: null,
    };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Duplicate");
    expect(mockDeleteCallCount).toBe(0);
  });

  it("returns 500 and clears the row when a duplicate is incomplete AND stale (crashed run)", async () => {
    mockInsertResult = { error: { code: "23505", message: "duplicate key value" } };
    mockMaybeSingleResult = {
      data: {
        processing_completed_at: null,
        processing_outcome: null,
        // [review gap-fill #719] older than the stale threshold → crashed, safe to clear
        processing_started_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      },
      error: null,
    };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Retry incomplete webhook");
    expect(mockDeleteCallCount).toBe(1);
  });

  it("[review gap-fill #719] does NOT clear an incomplete duplicate still in-flight (recent start) — 500 retry-later", async () => {
    // A concurrent re-delivery arriving while the first run is still processing
    // must NOT delete that row — doing so would orphan the in-flight run (its
    // completion UPDATE would match 0 rows) and let a later retry reprocess.
    mockInsertResult = { error: { code: "23505", message: "duplicate key value" } };
    mockMaybeSingleResult = {
      data: {
        processing_completed_at: null,
        processing_outcome: null,
        processing_started_at: new Date().toISOString(), // just started → in-flight
      },
      error: null,
    };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("In-flight, retry later");
    expect(mockDeleteCallCount).toBe(0); // row preserved for the in-flight run
  });

  it("[review gap-fill #719] clears the dedup row when the handler errors mid-dispatch (Step 5), so Stripe retries", async () => {
    // Fresh delivery (insert OK), but the process_transfer_reversal RPC fails → outcome
    // 'error' → Step 5 must DELETE the row + 500 so the next delivery reprocesses
    // instead of the row sticking around and short-circuiting to a duplicate 200.
    // Regression guard: dropping clearStripeWebhookEventRow in Step 5 fails this.
    mockInsertResult = { error: null };
    mockRpcResult = { data: null, error: { message: "synthetic update failure" } };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Handler error");
    expect(mockDeleteCallCount).toBe(1);
  });

  it("[review gap-fill #719] parallel deliveries: first succeeds (200 'OK'), second sees it in-flight → 500 retry-later, does NOT clear", async () => {
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
                  // [review gap-fill #719] the second (duplicate) delivery's dup
                  // lookup sees the first delivery's row still in-flight: recent
                  // processing_started_at, not yet completed.
                  return {
                    data: {
                      processing_completed_at: null,
                      processing_outcome: null,
                      processing_started_at: new Date().toISOString(),
                    },
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
                select() {
                  return {
                    then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
                      return resolve({ data: [{ id: "p-1" }], error: null });
                    },
                  };
                },
                then(resolve: (v: { data: null; error: null }) => unknown) {
                  return resolve({ data: null, error: null });
                },
              };
              return u;
            },
            delete() {
              const d: Record<string, unknown> = {
                eq() {
                  return {
                    then(resolve: (v: { data: null; error: null }) => unknown) {
                      return resolve({ data: null, error: null });
                    },
                  };
                },
              };
              return d;
            },
          };
        },
        async rpc(fn: string, _args?: unknown) {
          void _args;
          if (fn !== "process_transfer_reversal") throw new Error(`Unexpected rpc: ${fn}`);
          return { data: null, error: null };
        },
      } as never),
    );

    const [a, b] = await Promise.all([
      handleStripeWebhook(makeReq(), "platform"),
      handleStripeWebhook(makeReq(), "platform"),
    ]);
    expect(sequencedInsertCount).toBe(2);
    expect(a.status).toBe(200);
    expect(b.status).toBe(500);
    const bodies = [await a.text(), await b.text()];
    expect(bodies).toContain("OK");
    // The in-flight duplicate is asked to retry later, NOT cleared (clearing
    // would orphan the first run). "In-flight, retry later" ≠ "Retry incomplete webhook".
    expect(bodies).toContain("In-flight, retry later");
  });
});
