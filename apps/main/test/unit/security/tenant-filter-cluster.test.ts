// D-091 two-layer isolation — the open cross-tenant cluster.
//
// Each handler below ran a service-role query (RLS bypassed) against a
// tenant-scoped table with only a PK/FK filter, so a caller who knew another
// tenant's id could read/affect that tenant's row. The fix adds an explicit
// .eq("tenant_id", <caller's tenant>) to every such query. These tests drive the
// real handler with a recording service-role mock and assert the tenant_id filter
// is applied to the flagged table — they FAIL if the filter is dropped, which is
// exactly the cross-tenant exposure each issue describes.
//
// F-001/#715 (HIGH, real exploit) · F-015/#726 · F-018/#730 · F-027/#740 · F-039/#752

import { describe, it, expect, vi, beforeEach } from "vitest";

const T = "11111111-2222-3333-4444-555555555555";

// A chainable + thenable query stub: records every .eq(col) as `${table}.${col}`,
// serves .maybeSingle()/.single() reads, and resolves when an update/insert chain
// is awaited directly (via safeAwait).
function recordingChain(eqLog: string[], table: string, resp: { data?: unknown; error?: unknown }) {
  const r = { data: resp.data ?? null, error: resp.error ?? null };
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    select: self, update: self, insert: self, upsert: self, delete: self,
    order: self, limit: self, in: self, or: self, filter: self,
    eq: (col: string) => { eqLog.push(`${table}.${col}`); return chain; },
    maybeSingle: async () => r,
    single: async () => r,
    then: (resolve: (v: unknown) => void) => resolve(r),
  });
  return chain;
}
function recordingDb(eqLog: string[], responses: Record<string, { data?: unknown; error?: unknown }> = {}) {
  return { from: (t: string) => recordingChain(eqLog, t, responses[t] ?? {}) } as never;
}

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  serviceClient: vi.fn(),
  tenantClient: vi.fn(),
  deliverablesGate: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>("@/lib/auth/assert-permission");
  return { ...actual, assertPermission: mocks.assertPermission };
});
vi.mock("@/lib/db/service-role-client", () => ({ createServiceRoleClient: mocks.serviceClient }));
vi.mock("@/lib/db/tenant-client", () => ({ tenantClient: mocks.tenantClient }));
vi.mock("@/lib/deliverables/tier-gate", () => ({ assertDeliverablesAvailable: mocks.deliverablesGate }));
vi.mock("@/inngest/client", () => ({
  inngest: { send: vi.fn(), createFunction: (config: unknown, handler: unknown) => ({ config, handler }) },
}));

import { POST as resourcesPOST } from "@/app/api/bookings/[id]/resources/route";
import { POST as quoteSelectPOST } from "@/app/api/quote-options/[id]/select/route";
import { PATCH as forumsPATCH } from "@/app/api/forums/messages/[id]/route";
import { POST as cancelPOST } from "@/app/api/bookings/[id]/cancel/route";
import { taskSequenceStepFire } from "@/inngest/task-sequence-step-fire";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: T, source: { kind: "http_request", user_id: "u1" } },
    user: { id: "u1", auth_user_id: "a1", tenant_id: T, role: "owner", status: "active" },
  });
  mocks.deliverablesGate.mockResolvedValue({ ok: true });
});

function req(body: unknown = {}): Request {
  return new Request("https://t.example.com/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("F-001/#715 — trip_resources POST is tenant-scoped (the HIGH cross-tenant read)", () => {
  it("scopes the idempotency read by tenant_id, so another tenant's booking UUID can't return its row", async () => {
    const eqLog: string[] = [];
    // RLS-bypassed service-role row that WOULD leak without the tenant filter.
    mocks.serviceClient.mockReturnValue(recordingDb(eqLog, { trip_resources: { data: { id: "r1" } } }));
    const res = await resourcesPOST(req(), { params: Promise.resolve({ id: "victim-booking" }) });
    expect(res.status).toBe(200);
    expect(eqLog).toContain("trip_resources.tenant_id"); // the fix — without it, cross-tenant read
    expect(eqLog).toContain("trip_resources.booking_id");
  });
});

describe("F-027/#740 — quote-options select scopes every service-role mutation by tenant_id", () => {
  it("filters the quote_options unselect/select updates AND the quotes acceptance update by tenant_id", async () => {
    const eqLog: string[] = [];
    mocks.serviceClient.mockReturnValue(
      recordingDb(eqLog, { quote_options: { data: { id: "o1", tenant_id: T, quote_id: "q1" } } }),
    );
    const res = await quoteSelectPOST(req(), { params: Promise.resolve({ id: "o1" }) });
    expect(res.status).toBe(200);
    // Three service-role mutations, all now tenant-scoped.
    expect(eqLog.filter((e) => e === "quote_options.tenant_id")).toHaveLength(2);
    expect(eqLog).toContain("quotes.tenant_id");
  });
});

describe("F-039/#752 — forums message route scopes the parent-forums lookup by tenant_id", () => {
  it("adds tenant_id to the service-role forums lookup", async () => {
    const eqLog: string[] = [];
    mocks.serviceClient.mockReturnValue(
      recordingDb(eqLog, {
        forum_messages: { data: { id: "m1", forum_id: "f1", tenant_id: T } },
        forums: { data: { id: "f1", coordinator_user_id: "u1", is_locked: false } },
      }),
    );
    // 'pin' is a coordinator action; we only assert the forums read is tenant-scoped,
    // which happens before any moderation outcome — so the final status is irrelevant.
    await forumsPATCH(req({ action: "pin" }), { params: Promise.resolve({ id: "m1" }) }).catch(() => {});
    expect(eqLog).toContain("forums.tenant_id");
  });
});

describe("F-018/#730 — booking cancel scopes the payout_records service-role read by tenant_id", () => {
  it("filters the payout_records lookup by tenant_id", async () => {
    const eqLog: string[] = [];
    // tenantClient serves booking + commission (RLS-scoped in prod); the
    // payout_records read is on the service-role client — that's the fix.
    mocks.tenantClient.mockReturnValue(
      recordingDb(eqLog, {
        bookings: { data: { id: "b1", status: "confirmed" } },
        commissions: { data: { id: "c1", status: "received" } },
      }),
    );
    mocks.serviceClient.mockReturnValue(recordingDb(eqLog, { payout_records: { data: null } }));
    const res = await cancelPOST(req(), { params: Promise.resolve({ id: "b1" }) });
    expect(res.status).toBe(200);
    expect(eqLog).toContain("payout_records.tenant_id"); // the fix
  });
});

describe("F-015/#726 — task-sequence step fire scopes contact/booking reads by tenant_id", () => {
  it("adds tenant_id to the service-role contacts read", async () => {
    const eqLog: string[] = [];
    mocks.serviceClient.mockReturnValue(
      recordingDb(eqLog, {
        task_sequence_runs: {
          data: {
            id: "r1", tenant_id: T, sequence_id: "s1", status: "active",
            contact_id: "ct1", quote_id: null, booking_id: null,
            steps_snapshot: [{ step_index: 0 }],
          },
        },
        contacts: { data: { first_name: "A", last_name: "B", pipeline_stage_key: null } },
      }),
    );
    // We assert only the tenant-scoping of the contact read, which happens while
    // building the substitution context — before any step action; downstream
    // step-send logic is out of scope here.
    // The handler is inline in createFunction; the @/inngest/client mock returns
    // it as `.handler`, which the real InngestFunction type doesn't expose.
    const fn = taskSequenceStepFire as unknown as {
      handler: (a: { event: { data: unknown } }) => Promise<unknown>;
    };
    await fn.handler({
      event: { data: { tenant_id: T, sequence_run_id: "r1", step_index: 0 } },
    }).catch(() => {});
    expect(eqLog).toContain("contacts.tenant_id");
  });
});
