// Stripe webhook handler — per-branch happy-path assertions.
//
// The existing files cover error propagation (every branch under DB-error
// injection) and concurrency/idempotency. This file fills the gap mutation
// testing flagged: 148 surviving mutants concentrated in the per-branch
// success paths. The pattern here is to spy on every DB call and assert the
// exact table + payload, which kills StringLiteral / ObjectLiteral / Logical
// mutants that the existing tests don't catch because their mocks return a
// canned shape regardless of inputs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// DB mock — every `.from(table).update(payload)` and `.insert(payload)` call
// is captured into a journal we assert against.
// ---------------------------------------------------------------------------

type DbCall = { table: string; op: "insert" | "update"; payload: unknown };
type RpcCall = { fn: string; args: unknown };
let dbCalls: DbCall[];
let rpcCalls: RpcCall[];
let progressToCalls: Array<{ tenantId: string; stage: string }>;
// #744: tracks .eq(col,val) calls on payout_records update chains so tests can
// assert the status='processing' guard is present.
let updateEqCalls: Array<{ table: string; col: string; val: unknown }>;

let insertResult: { error: { code?: string; message: string } | null } = { error: null };
let updateResult: { data: unknown; error: { message: string } | null } = { data: null, error: null };
// Result of an `.update(...).or(...).select("id")` chain (#1583 CAS guard).
// Defaults to 1 row matched (the non-racing happy path). Set to an empty
// array to script a concurrent-newer-event race (the CAS WHERE clause
// matched 0 rows because a later event already won).
let updateSelectResult: { data: unknown[]; error: { message: string } | null } | null = {
  data: [{ id: "t-1" }],
  error: null,
};
let selectMaybeSingle: { data: unknown; error: null } = { data: null, error: null };
let selectArray: { data: unknown[]; error: null } = { data: [], error: null };
// Return value for db.rpc() calls. Default data=1 so transfer.reversed sees 1 row processed.
let mockRpcResult: { data: unknown; error: { message: string } | null } = { data: 1, error: null };

let mockEventType = "transfer.reversed";
let mockEventData: Record<string, unknown> = { id: "tr_1" };
let mockEventPreviousAttributes: Record<string, unknown> | undefined = undefined;

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      return {
        async insert(payload: unknown) {
          dbCalls.push({ table, op: "insert", payload });
          return insertResult;
        },
        select(_cols: string) {
          void _cols;
          const chain: Record<string, unknown> = {
            eq() { return chain; },
            in() { return chain; },
            async maybeSingle() { return selectMaybeSingle; },
            async single() { return selectMaybeSingle; },
            then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
              return resolve(selectArray);
            },
          };
          return chain;
        },
        update(payload: unknown) {
          dbCalls.push({ table, op: "update", payload });
          const u: Record<string, unknown> = {
            eq(col: string, val: unknown) { updateEqCalls.push({ table, col, val }); return u; },
            in() { return u; },
            or() { return u; },
            select(_cols: string) {
              void _cols;
              return {
                then(resolve: (v: { data: unknown[]; error: { message: string } | null }) => unknown) {
                  return resolve(
                    updateSelectResult ?? { data: selectArray.data, error: updateResult.error },
                  );
                },
              };
            },
            then(resolve: (v: { data: unknown; error: { message: string } | null }) => unknown) {
              return resolve(updateResult);
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
    async rpc(fn: string, args?: unknown) {
      rpcCalls.push({ fn, args });
      return mockRpcResult;
    },
  }),
}));

vi.mock("@/lib/onboarding/state-machine", () => ({
  async progressTo(tenantId: string, stage: string) {
    progressToCalls.push({ tenantId, stage });
  },
}));

vi.mock("stripe", () => ({
  default: class FakeStripe {
    webhooks = {
      constructEvent: (_body: string, _sig: string, _secret: string) => {
        void _body; void _sig; void _secret;
        return {
          id: `evt_test_${mockEventType}`,
          type: mockEventType,
          created: Math.floor(Date.now() / 1000),
          data: {
            object: mockEventData,
            ...(mockEventPreviousAttributes ? { previous_attributes: mockEventPreviousAttributes } : {}),
          },
        };
      },
    };
    static errors = { StripeError: class StripeError extends Error {} };
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
  dbCalls = [];
  rpcCalls = [];
  progressToCalls = [];
  updateEqCalls = [];
  insertResult = { error: null };
  updateResult = { data: null, error: null };
  updateSelectResult = { data: [{ id: "t-1" }], error: null };
  selectMaybeSingle = { data: null, error: null };
  selectArray = { data: [], error: null };
  mockRpcResult = { data: 1, error: null };
  mockEventType = "transfer.reversed";
  mockEventData = { id: "tr_1" };
  mockEventPreviousAttributes = undefined;
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_fake_connect";
});

afterEach(() => {
  vi.restoreAllMocks();
});

function findUpdate(table: string): Record<string, unknown> | undefined {
  return dbCalls.find((c) => c.table === table && c.op === "update")?.payload as
    | Record<string, unknown>
    | undefined;
}

// ---------------------------------------------------------------------------
// Idempotency-row write (header block — applies to every event)
// ---------------------------------------------------------------------------

describe("Stripe webhook — header: idempotency insert", () => {
  it("inserts a stripe_webhook_events row with event_type, endpoint='platform', and tenant_id=null", async () => {
    mockEventType = "transfer.reversed";
    mockEventData = { id: "tr_1" };
    selectArray = { data: [], error: null };
    await handleStripeWebhook(makeReq(), "platform");

    const ins = dbCalls.find(
      (c) => c.table === "stripe_webhook_events" && c.op === "insert",
    )?.payload as Record<string, unknown> | undefined;
    expect(ins).toBeDefined();
    expect(ins!.event_type).toBe("transfer.reversed");
    expect(ins!.endpoint).toBe("platform");
    expect(ins!.tenant_id).toBeNull();
    expect(ins!.processing_started_at).toEqual(expect.any(String));
  });

  it("inserts with endpoint='connect' when the connect handler is invoked", async () => {
    mockEventType = "transfer.reversed";
    await handleStripeWebhook(makeReq(), "connect");
    const ins = dbCalls.find(
      (c) => c.table === "stripe_webhook_events" && c.op === "insert",
    )?.payload as Record<string, unknown> | undefined;
    expect(ins!.endpoint).toBe("connect");
  });

  it("writes the outcome row with processing_completed_at set on success", async () => {
    mockEventType = "transfer.reversed";
    selectArray = { data: [{ id: "p-1" }], error: null };
    await handleStripeWebhook(makeReq(), "platform");
    const u = findUpdate("stripe_webhook_events");
    expect(u).toBeDefined();
    expect(u!.processing_completed_at).toEqual(expect.any(String));
    expect(u!.processing_outcome).toBe("success");
  });

  it("writes outcome='error' with error_detail when a branch throws", async () => {
    mockEventType = "transfer.reversed";
    mockRpcResult = { data: null, error: { message: "synthetic" } };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(500);
    const outcomeUpdate = dbCalls.find(
      (c) => c.table === "stripe_webhook_events" && c.op === "update",
    )?.payload as Record<string, unknown> | undefined;
    expect(outcomeUpdate!.processing_outcome).toBe("error");
    expect(outcomeUpdate!.error_detail).toEqual(expect.stringContaining("synthetic"));
  });
});

// ---------------------------------------------------------------------------
// transfer.reversed (§14.9 clawback)
//
// The entire ledger unwind (status flip, balance credit, commission update,
// review queue insert) is now handled by the atomic process_transfer_reversal()
// RPC. The webhook handler calls db.rpc() once and checks the returned row count.
// 0 rows → outcome 'unhandled' → 200 (not ours or already reversed; Stripe stops
// retrying). RPC error → throws → outcome 'error' → 500 → Stripe retries.
// ---------------------------------------------------------------------------

describe("Stripe webhook — transfer.reversed", () => {
  it("calls process_transfer_reversal RPC with transfer id and reversal amount", async () => {
    mockEventType = "transfer.reversed";
    mockEventData = { id: "tr_abc", amount_reversed: 40000 };
    // mockRpcResult defaults to { data: 1, error: null } → 1 row processed → success
    await handleStripeWebhook(makeReq(), "platform");
    const call = rpcCalls.find((c) => c.fn === "process_transfer_reversal");
    expect(call).toBeDefined();
    expect(call!.args).toEqual(
      expect.objectContaining({ p_transfer_id: "tr_abc", p_this_reversal_cents: 40000 }),
    );
  });

  it("returns 200 with outcome='unhandled' when RPC returns 0 (no paid row matched)", async () => {
    mockEventType = "transfer.reversed";
    mockRpcResult = { data: 0, error: null };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(200);
    const outcome = dbCalls.find(
      (c) => c.table === "stripe_webhook_events" && c.op === "update",
    )?.payload as Record<string, unknown> | undefined;
    expect(outcome!.processing_outcome).toBe("unhandled");
  });

  it("returns 500 outcome='error' when process_transfer_reversal RPC errors (genuine DB error)", async () => {
    mockEventType = "transfer.reversed";
    mockEventData = { id: "tr_dberr", amount_reversed: 10000 };
    mockRpcResult = { data: null, error: { message: "deadlock detected" } };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(500);
    const outcome = dbCalls.find(
      (c) => c.table === "stripe_webhook_events" && c.op === "update",
    )?.payload as Record<string, unknown> | undefined;
    expect(outcome!.processing_outcome).toBe("error");
    expect(outcome!.error_detail).toEqual(expect.stringContaining("deadlock detected"));
  });

  it("passes partial reversal delta (amount_reversed minus previous_attributes.amount_reversed) to RPC", async () => {
    // Stripe delivers cumulative amount_reversed; the handler computes the delta so
    // only the newly-reversed portion is credited, not the full transfer amount.
    mockEventType = "transfer.reversed";
    mockEventData = { id: "tr_partial", amount_reversed: 30000 };
    mockEventPreviousAttributes = { amount_reversed: 15000 };
    await handleStripeWebhook(makeReq(), "platform");
    const call = rpcCalls.find((c) => c.fn === "process_transfer_reversal");
    expect(call!.args).toEqual(
      expect.objectContaining({ p_transfer_id: "tr_partial", p_this_reversal_cents: 15000 }),
    );
  });
});

// ---------------------------------------------------------------------------
// checkout.session.completed
// ---------------------------------------------------------------------------

describe("Stripe webhook — checkout.session.completed", () => {
  beforeEach(() => {
    mockEventType = "checkout.session.completed";
    mockEventData = {
      id: "cs_1",
      subscription: "sub_1",
      customer: "cus_1",
      metadata: { tenant_id: "t-1" },
    };
  });

  it("writes stripe_subscription_id + stripe_customer_id onto the tenant row", async () => {
    selectMaybeSingle = { data: { onboarding_stage: "subscription" }, error: null };
    await handleStripeWebhook(makeReq(), "platform");
    const u = findUpdate("tenants");
    expect(u).toBeDefined();
    expect(u!.stripe_subscription_id).toBe("sub_1");
    expect(u!.stripe_customer_id).toBe("cus_1");
  });

  it("advances onboarding to 'connect_setup' when current stage is 'subscription' (sub_host)", async () => {
    selectMaybeSingle = { data: { onboarding_stage: "subscription", tenant_type: "sub_host" }, error: null };
    await handleStripeWebhook(makeReq(), "platform");
    expect(progressToCalls).toContainEqual({ tenantId: "t-1", stage: "connect_setup" });
  });

  it("advances onboarding to 'branding' when tenant_type is byo_host — BYO skips connect_setup (§3.1)", async () => {
    selectMaybeSingle = { data: { onboarding_stage: "subscription", tenant_type: "byo_host" }, error: null };
    await handleStripeWebhook(makeReq(), "platform");
    expect(progressToCalls).toContainEqual({ tenantId: "t-1", stage: "branding" });
    expect(progressToCalls).not.toContainEqual({ tenantId: "t-1", stage: "connect_setup" });
  });

  it("does NOT advance onboarding when current stage is not 'subscription'", async () => {
    selectMaybeSingle = { data: { onboarding_stage: "branding" }, error: null };
    await handleStripeWebhook(makeReq(), "platform");
    expect(progressToCalls).toHaveLength(0);
  });

  it("returns 200 outcome='unhandled' when metadata.tenant_id is absent", async () => {
    mockEventData = { id: "cs_1", subscription: "sub_1", customer: "cus_1", metadata: {} };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(200);
    expect(dbCalls.some((c) => c.table === "tenants" && c.op === "update")).toBe(false);
  });

  it("returns 200 outcome='unhandled' when session.subscription is missing", async () => {
    mockEventData = { id: "cs_1", customer: "cus_1", metadata: { tenant_id: "t-1" } };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(200);
    expect(dbCalls.some((c) => c.table === "tenants" && c.op === "update")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// account.updated
// ---------------------------------------------------------------------------

describe("Stripe webhook — account.updated", () => {
  beforeEach(() => {
    mockEventType = "account.updated";
  });

  it("on tax_form + details_submitted: writes w9_received_at and progresses to state_of_operation", async () => {
    mockEventData = { id: "acct_1", details_submitted: true, payouts_enabled: false };
    selectMaybeSingle = { data: { id: "t-1", onboarding_stage: "tax_form" }, error: null };
    await handleStripeWebhook(makeReq(), "platform");
    const u = findUpdate("tenants");
    expect(u).toBeDefined();
    expect(u!.w9_received_at).toEqual(expect.any(String));
    expect(progressToCalls).toContainEqual({ tenantId: "t-1", stage: "state_of_operation" });
  });

  it("on connect_setup + payouts_enabled: writes connect_setup_completed_at and progresses to branding", async () => {
    mockEventData = { id: "acct_1", details_submitted: false, payouts_enabled: true };
    selectMaybeSingle = { data: { id: "t-1", onboarding_stage: "connect_setup" }, error: null };
    await handleStripeWebhook(makeReq(), "platform");
    const u = findUpdate("tenants");
    expect(u).toBeDefined();
    expect(u!.connect_setup_completed_at).toEqual(expect.any(String));
    expect(progressToCalls).toContainEqual({ tenantId: "t-1", stage: "branding" });
  });

  it("does NOT write or progress when neither branch condition is met (e.g. details_submitted on connect_setup stage)", async () => {
    mockEventData = { id: "acct_1", details_submitted: true, payouts_enabled: false };
    selectMaybeSingle = { data: { id: "t-1", onboarding_stage: "connect_setup" }, error: null };
    await handleStripeWebhook(makeReq(), "platform");
    expect(dbCalls.some((c) => c.table === "tenants" && c.op === "update")).toBe(false);
    expect(progressToCalls).toHaveLength(0);
  });

  it("returns 200 outcome='unhandled' when no tenant matches the connect account", async () => {
    mockEventData = { id: "acct_1", details_submitted: true, payouts_enabled: true };
    selectMaybeSingle = { data: null, error: null };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(200);
    expect(dbCalls.some((c) => c.table === "tenants" && c.op === "update")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// customer.subscription.{created,updated,deleted}
// ---------------------------------------------------------------------------

describe("Stripe webhook — customer.subscription.* status handling", () => {
  it("active subscription: clears non_paying_since and sets subscription_status='active'", async () => {
    mockEventType = "customer.subscription.updated";
    mockEventData = { id: "sub_1", status: "active" };
    selectMaybeSingle = {
      data: { id: "t-1", non_paying_since: "2026-01-01T00:00:00Z" },
      error: null,
    };
    await handleStripeWebhook(makeReq(), "platform");
    const u = findUpdate("tenants");
    expect(u).toBeDefined();
    expect(u!.subscription_status).toBe("active");
    expect(u!.non_paying_since).toBeNull();
  });

  it("trialing subscription: clears non_paying_since (trialing counts as paying)", async () => {
    mockEventType = "customer.subscription.updated";
    mockEventData = { id: "sub_1", status: "trialing" };
    selectMaybeSingle = {
      data: { id: "t-1", non_paying_since: "2026-01-01T00:00:00Z" },
      error: null,
    };
    await handleStripeWebhook(makeReq(), "platform");
    const u = findUpdate("tenants");
    expect(u!.non_paying_since).toBeNull();
    expect(u!.subscription_status).toBe("trialing");
  });

  it("past_due subscription with no existing non_paying_since: starts the grace clock", async () => {
    mockEventType = "customer.subscription.updated";
    mockEventData = { id: "sub_1", status: "past_due" };
    selectMaybeSingle = { data: { id: "t-1", non_paying_since: null }, error: null };
    await handleStripeWebhook(makeReq(), "platform");
    const u = findUpdate("tenants");
    expect(u!.subscription_status).toBe("past_due");
    expect(u!.non_paying_since).toEqual(expect.any(String));
  });

  it("past_due subscription with existing non_paying_since: PRESERVES the older timestamp", async () => {
    // Grace-clock invariant: rapid status churn must not reset the clock.
    mockEventType = "customer.subscription.updated";
    mockEventData = { id: "sub_1", status: "past_due" };
    selectMaybeSingle = {
      data: { id: "t-1", non_paying_since: "2026-01-01T00:00:00Z" },
      error: null,
    };
    await handleStripeWebhook(makeReq(), "platform");
    const u = findUpdate("tenants");
    expect(u!.subscription_status).toBe("past_due");
    expect("non_paying_since" in u!).toBe(false);
  });

  it("deleted event: writes subscription_status='canceled' regardless of sub.status", async () => {
    mockEventType = "customer.subscription.deleted";
    mockEventData = { id: "sub_1", status: "active" };
    selectMaybeSingle = { data: { id: "t-1", non_paying_since: null }, error: null };
    await handleStripeWebhook(makeReq(), "platform");
    const u = findUpdate("tenants");
    expect(u!.subscription_status).toBe("canceled");
  });

  it("returns 200 outcome='unhandled' when no tenant matches the subscription id", async () => {
    mockEventType = "customer.subscription.updated";
    mockEventData = { id: "sub_unknown", status: "active" };
    selectMaybeSingle = { data: null, error: null };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(200);
    expect(dbCalls.some((c) => c.table === "tenants" && c.op === "update")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// invoice.payment_succeeded
// ---------------------------------------------------------------------------

describe("Stripe webhook — invoice.payment_succeeded", () => {
  beforeEach(() => {
    mockEventType = "invoice.payment_succeeded";
  });

  it("clears non_paying_since on every payment_succeeded (unconditional)", async () => {
    mockEventData = { parent: { subscription_details: { subscription: "sub_1" } } };
    selectMaybeSingle = { data: { id: "t-1", subscription_status: "active" }, error: null };
    await handleStripeWebhook(makeReq(), "platform");
    const u = findUpdate("tenants");
    expect(u).toBeDefined();
    expect(u!.non_paying_since).toBeNull();
  });

  it("bumps subscription_status to 'active' when current status lags (e.g. 'past_due')", async () => {
    mockEventData = { parent: { subscription_details: { subscription: "sub_1" } } };
    selectMaybeSingle = { data: { id: "t-1", subscription_status: "past_due" }, error: null };
    await handleStripeWebhook(makeReq(), "platform");
    const u = findUpdate("tenants");
    expect(u!.subscription_status).toBe("active");
  });

  it("does NOT overwrite subscription_status when it is already 'active'", async () => {
    mockEventData = { parent: { subscription_details: { subscription: "sub_1" } } };
    selectMaybeSingle = { data: { id: "t-1", subscription_status: "active" }, error: null };
    await handleStripeWebhook(makeReq(), "platform");
    const u = findUpdate("tenants");
    expect("subscription_status" in u!).toBe(false);
  });

  it("does NOT overwrite subscription_status when it is already 'trialing'", async () => {
    mockEventData = { parent: { subscription_details: { subscription: "sub_1" } } };
    selectMaybeSingle = { data: { id: "t-1", subscription_status: "trialing" }, error: null };
    await handleStripeWebhook(makeReq(), "platform");
    const u = findUpdate("tenants");
    expect("subscription_status" in u!).toBe(false);
  });

  it("returns 200 outcome='unhandled' when invoice.parent.subscription_details.subscription is missing", async () => {
    mockEventData = { parent: { subscription_details: {} } };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(200);
    expect(dbCalls.some((c) => c.table === "tenants" && c.op === "update")).toBe(false);
  });

  it("returns 200 outcome='unhandled' when no tenant matches the subscription id", async () => {
    mockEventData = { parent: { subscription_details: { subscription: "sub_unknown" } } };
    selectMaybeSingle = { data: null, error: null };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(200);
    expect(dbCalls.some((c) => c.table === "tenants" && c.op === "update")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// invoice.payment_failed
// ---------------------------------------------------------------------------

describe("Stripe webhook — invoice.payment_failed", () => {
  beforeEach(() => {
    mockEventType = "invoice.payment_failed";
  });

  it("writes subscription_status='past_due'", async () => {
    mockEventData = { parent: { subscription_details: { subscription: "sub_1" } } };
    selectMaybeSingle = { data: { id: "t-1", non_paying_since: null }, error: null };
    await handleStripeWebhook(makeReq(), "platform");
    const u = findUpdate("tenants");
    expect(u!.subscription_status).toBe("past_due");
  });

  it("starts the grace clock when non_paying_since is null", async () => {
    mockEventData = { parent: { subscription_details: { subscription: "sub_1" } } };
    selectMaybeSingle = { data: { id: "t-1", non_paying_since: null }, error: null };
    await handleStripeWebhook(makeReq(), "platform");
    const u = findUpdate("tenants");
    expect(u!.non_paying_since).toEqual(expect.any(String));
  });

  it("PRESERVES non_paying_since when already set (clock runs from first failure)", async () => {
    mockEventData = { parent: { subscription_details: { subscription: "sub_1" } } };
    selectMaybeSingle = {
      data: { id: "t-1", non_paying_since: "2026-01-01T00:00:00Z" },
      error: null,
    };
    await handleStripeWebhook(makeReq(), "platform");
    const u = findUpdate("tenants");
    expect("non_paying_since" in u!).toBe(false);
  });

  it("returns 200 outcome='unhandled' when invoice.parent.subscription_details.subscription is missing", async () => {
    mockEventData = { parent: {} };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(200);
    expect(dbCalls.some((c) => c.table === "tenants" && c.op === "update")).toBe(false);
  });

  it("returns 200 outcome='unhandled' when no tenant matches the subscription id", async () => {
    mockEventData = { parent: { subscription_details: { subscription: "sub_unknown" } } };
    selectMaybeSingle = { data: null, error: null };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(200);
    expect(dbCalls.some((c) => c.table === "tenants" && c.op === "update")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #1583 — CAS guard on the subscription-status UPDATE itself
//
// The JS staleness check (isStaleSubscriptionEvent) is a cheap early-out;
// two concurrent deliveries can both pass it before either writes. The
// `.or(subscription_status_event_at.is.null,...lt.<created>)` WHERE clause
// makes the check atomic in the DB — a 0-row result means a concurrent
// newer event already won, and this event's write must be silently
// dropped (not treated as an error, not overwriting the newer state).
// ---------------------------------------------------------------------------

describe("Stripe webhook — #1583 CAS guard (concurrent newer event wins the race)", () => {
  it("customer.subscription.updated: 0-row CAS result leaves outcome='unhandled', not 'success'", async () => {
    mockEventType = "customer.subscription.updated";
    mockEventData = { id: "sub_1", status: "active" };
    selectMaybeSingle = { data: { id: "t-1", non_paying_since: null }, error: null };
    updateSelectResult = { data: [], error: null };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(200);
    const outcome = dbCalls.find(
      (c) => c.table === "stripe_webhook_events" && c.op === "update",
    )?.payload as Record<string, unknown> | undefined;
    expect(outcome!.processing_outcome).toBe("unhandled");
  });

  it("invoice.payment_succeeded: 0-row CAS result leaves outcome='unhandled', not 'success'", async () => {
    mockEventType = "invoice.payment_succeeded";
    mockEventData = { parent: { subscription_details: { subscription: "sub_1" } } };
    selectMaybeSingle = { data: { id: "t-1", subscription_status: "past_due" }, error: null };
    updateSelectResult = { data: [], error: null };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(200);
    const outcome = dbCalls.find(
      (c) => c.table === "stripe_webhook_events" && c.op === "update",
    )?.payload as Record<string, unknown> | undefined;
    expect(outcome!.processing_outcome).toBe("unhandled");
  });

  it("invoice.payment_failed: 0-row CAS result leaves outcome='unhandled', not 'success'", async () => {
    mockEventType = "invoice.payment_failed";
    mockEventData = { parent: { subscription_details: { subscription: "sub_1" } } };
    selectMaybeSingle = { data: { id: "t-1", non_paying_since: null }, error: null };
    updateSelectResult = { data: [], error: null };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(200);
    const outcome = dbCalls.find(
      (c) => c.table === "stripe_webhook_events" && c.op === "update",
    )?.payload as Record<string, unknown> | undefined;
    expect(outcome!.processing_outcome).toBe("unhandled");
  });
});

// ---------------------------------------------------------------------------
// Default branch (unknown event type)
// ---------------------------------------------------------------------------

describe("Stripe webhook — unknown event type", () => {
  it("returns 200 outcome='unhandled' for an event type not in the dispatch switch", async () => {
    mockEventType = "some.bogus.event_type";
    mockEventData = { id: "x" };
    const res = await handleStripeWebhook(makeReq(), "platform");
    expect(res.status).toBe(200);
    expect(dbCalls.some((c) => c.table === "tenants" && c.op === "update")).toBe(false);
    expect(dbCalls.some((c) => c.table === "payout_records" && c.op === "update")).toBe(false);
    const outcome = dbCalls.find(
      (c) => c.table === "stripe_webhook_events" && c.op === "update",
    )?.payload as Record<string, unknown> | undefined;
    expect(outcome!.processing_outcome).toBe("unhandled");
  });
});
