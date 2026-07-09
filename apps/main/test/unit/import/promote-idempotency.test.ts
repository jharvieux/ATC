// BP34 §34.5 — promoteImport orchestration (#1576 / #1712).
//
// Since #1712 the exactly-once guarantee lives in Postgres: the claim, the
// contact/booking/commission inserts, the contact_imports row, and the finalize
// all run inside ONE atomic RPC (public.promote_import). A mid-sequence crash
// can no longer orphan a duplicate contact/booking — the transaction either
// commits whole or rolls back whole. That property is proven end-to-end against
// a real database in test/integration/import-promote-atomicity.test.ts (it can't
// be exercised with a mock — a mock has no transaction to roll back).
//
// This suite pins the APP-LAYER contract that remains meaningful with the writes
// pushed into SQL:
//   1. The non-write early exits still short-circuit BEFORE any RPC call
//      (unsupported doc type; sub-host booking block; missing commission rate).
//   2. The values resolved outside the transaction (commission rate, canonical
//      line/ship ids, contact-name split) are actually forwarded into the RPC —
//      if they weren't, the atomic write would persist wrong data.
//   3. The RPC's jsonb result is mapped to the right PromoteResult, including the
//      idempotent already_accepted path (why: a double-click / retry must return
//      the existing records as success, never a spurious duplicate or error).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit/write", () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock("@/lib/canonical/resolve-canonical", () => ({
  resolveCanonical: vi.fn(async (_name: string, kind: "line" | "ship") =>
    kind === "line"
      ? { matched: true as const, id: "line-canon-1" }
      : { matched: true as const, id: "ship-canon-1" },
  ),
}));
vi.mock("@/lib/import/resolve-commission-rate", () => ({
  resolveCommissionRate: vi.fn(async () => rateResult),
}));

import { promoteImport } from "@/lib/import/promote";

const TENANT_ID = "tenant-1";
const ROW_ID = "row-1";

// Mutable so a test can force the "rate missing" branch.
let rateResult: { rate: number; source: string } | null = { rate: 0.15, source: "doc_parsed" };

type RpcResult = {
  status: "promoted" | "already_accepted" | "conflict" | "not_found";
  contact_id?: string | null;
  booking_id?: string | null;
  commission_id?: string | null;
  row_status?: string | null;
};

// Records every call so tests can assert on what the app forwarded / whether the
// RPC was reached at all.
type RpcCall = { fn: string; params: Record<string, unknown> };

// Minimal svc fake: serves the queue-row load + tenants lookup via `from`, and
// captures `rpc` calls. The real writes happen in Postgres, so `from` only needs
// to answer the two reads and swallow the rate-missing status reset.
function makeSvc(opts: {
  queueRow: Record<string, unknown> | null;
  tenantType?: string;
  rpc: RpcResult | { error: string };
}) {
  const rpcCalls: RpcCall[] = [];
  const svc = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "update"]) chain[m] = () => chain;
      chain.maybeSingle = async () => {
        if (table === "tenants") return { data: { tenant_type: opts.tenantType ?? "byo_host" }, error: null };
        return { data: opts.queueRow, error: null };
      };
      // Awaitable terminal for the rate-missing `.update(...).eq(...)` reset.
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
      return chain;
    },
    async rpc(fn: string, params: Record<string, unknown>) {
      rpcCalls.push({ fn, params });
      if ("error" in opts.rpc) return { data: null, error: { message: opts.rpc.error } };
      return { data: opts.rpc, error: null };
    },
  };
  return { svc: svc as unknown as Parameters<typeof promoteImport>[0]["svc"], rpcCalls };
}

function bookingRow(status = "pending_review", extra: Record<string, unknown> = {}) {
  return {
    id: ROW_ID,
    tenant_id: TENANT_ID,
    import_path: "email",
    source_ref: "msg-1",
    document_type: "booking_confirmation",
    raw_extracted_fields: {
      passenger_last_names: ["Van Der Berg"],
      cruise_line: "Carnival",
      ship_name: "Vista",
      sailing_date: "2026-09-01",
      total_amount_cents: 500000,
      currency: "USD",
      provider_booking_ref: "PNR123",
    },
    extraction_overall_confidence: 0.9,
    submitted_by_user_id: null,
    status,
    promoted_contact_id: null,
    promoted_booking_id: null,
    ...extra,
  };
}

function leadRow() {
  return {
    id: ROW_ID,
    tenant_id: TENANT_ID,
    import_path: "email",
    source_ref: "lead-1",
    document_type: "lead_notification",
    raw_extracted_fields: { contact_name: "Ada Lovelace", contact_email: "ada@example.com", interest_summary: "Alaska" },
    extraction_overall_confidence: 0.8,
    submitted_by_user_id: null,
    status: "pending_review",
    promoted_contact_id: null,
    promoted_booking_id: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rateResult = { rate: 0.15, source: "doc_parsed" };
});

describe("promoteImport — non-write early exits never reach the RPC (#1712)", () => {
  it("unsupported document_type → needs_review, no RPC call", async () => {
    const { svc, rpcCalls } = makeSvc({
      queueRow: { ...bookingRow(), document_type: "commission_statement" },
      rpc: { status: "promoted" },
    });
    const result = await promoteImport({ queue_row_id: ROW_ID, svc, acceptingUserId: "u1" });
    expect(result).toEqual({ ok: false, needs_review: true, reason: "unsupported_document_type" });
    expect(rpcCalls).toHaveLength(0);
  });

  it("sub-host tenant cannot import a booking → error, no RPC call (§34.9)", async () => {
    const { svc, rpcCalls } = makeSvc({ queueRow: bookingRow(), tenantType: "sub_host", rpc: { status: "promoted" } });
    const result = await promoteImport({ queue_row_id: ROW_ID, svc, acceptingUserId: "u1" });
    expect(result).toEqual({ ok: false, error: "booking_import_not_permitted_for_tenant_type:sub_host" });
    expect(rpcCalls).toHaveLength(0);
  });

  it("commission rate unresolved → needs_review, no promote RPC (row stays in review)", async () => {
    rateResult = null; // §34.7.3 fall-through: no rate anywhere
    const { svc, rpcCalls } = makeSvc({ queueRow: bookingRow(), rpc: { status: "promoted" } });
    const result = await promoteImport({ queue_row_id: ROW_ID, svc, acceptingUserId: "u1" });
    expect(result).toEqual({ ok: false, needs_review: true, reason: "commission_rate_missing" });
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("promoteImport — resolved inputs are forwarded into the atomic RPC (#1712)", () => {
  it("booking: rate + canonical ids + split name reach the RPC; 'promoted' → ok with ids", async () => {
    const { svc, rpcCalls } = makeSvc({
      queueRow: bookingRow(),
      rpc: { status: "promoted", contact_id: "c-1", booking_id: "b-1", commission_id: "cm-1" },
    });
    const result = await promoteImport({ queue_row_id: ROW_ID, svc, acceptingUserId: "u1" });

    expect(result).toEqual({ ok: true, contact_id: "c-1", booking_id: "b-1", commission_id: "cm-1" });
    expect(rpcCalls).toHaveLength(1);
    const p = rpcCalls[0]!.params;
    expect(p.p_is_booking).toBe(true);
    // Resolved outside the transaction, must be persisted by the RPC:
    expect(p.p_commission_rate).toBe(0.15);
    expect(p.p_commission_rate_source).toBe("doc_parsed");
    expect(p.p_cruise_line_id).toBe("line-canon-1");
    expect(p.p_cruise_ship_id).toBe("ship-canon-1");
    // Name split: first token → first_name, remainder → last_name.
    expect(p.p_contact_first_name).toBe("Van");
    expect(p.p_contact_last_name).toBe("Der Berg");
    // Booking-path contact carries no dedup key — the RPC's atomicity is what
    // keeps it exactly-once.
    expect(p.p_contact_email).toBeNull();
    expect(p.p_claimable_statuses).toEqual(["pending_review", "pending_validation"]);
    expect(p.p_contact_source_ref).toBe("email:msg-1");
  });

  it("lead: is_booking=false and no booking fields are sent", async () => {
    const { svc, rpcCalls } = makeSvc({ queueRow: leadRow(), rpc: { status: "promoted", contact_id: "c-9" } });
    const result = await promoteImport({ queue_row_id: ROW_ID, svc, acceptingUserId: "u1" });

    expect(result).toEqual({ ok: true, contact_id: "c-9" });
    const p = rpcCalls[0]!.params;
    expect(p.p_is_booking).toBe(false);
    expect(p.p_contact_email).toBe("ada@example.com");
    expect(p.p_total_amount_cents).toBeNull();
    expect(p.p_commission_rate).toBeNull();
  });
});

describe("promoteImport — RPC result mapping (#1712)", () => {
  it("already_accepted → idempotent success with the existing records, no commission_id", async () => {
    // WHY: a double-click / whole-step Inngest retry hits an already-accepted
    // row. The RPC returns the prior ids; the caller must see success, never a
    // duplicate write or a spurious error.
    const { svc } = makeSvc({
      queueRow: bookingRow("accepted", { promoted_contact_id: "c-done", promoted_booking_id: "b-done" }),
      rpc: { status: "already_accepted", contact_id: "c-done", booking_id: "b-done" },
    });
    const result = await promoteImport({ queue_row_id: ROW_ID, svc, acceptingUserId: "u2" });
    expect(result).toEqual({ ok: true, contact_id: "c-done", booking_id: "b-done" });
  });

  it("conflict → not_promotable_status:<live status>", async () => {
    const { svc } = makeSvc({ queueRow: bookingRow(), rpc: { status: "conflict", row_status: "rejected" } });
    const result = await promoteImport({ queue_row_id: ROW_ID, svc, acceptingUserId: "u3" });
    expect(result).toEqual({ ok: false, error: "not_promotable_status:rejected" });
  });

  it("RPC error surfaces as a promote failure (mapped to 500 by the route)", async () => {
    const { svc } = makeSvc({ queueRow: leadRow(), rpc: { error: "deadlock detected" } });
    const result = await promoteImport({ queue_row_id: ROW_ID, svc, acceptingUserId: "u1" });
    expect(result).toEqual({ ok: false, error: "promote_import_rpc_failed: deadlock detected" });
  });
});
