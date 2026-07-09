// #1576 / #1712 — POST /api/imports/review/[id]/accept: promoter-result → HTTP
// mapping.
//
// WHY this matters: the handler's job is to translate promoteImport's result
// into the right HTTP status. Since #1712 the promote path is a single atomic
// RPC, so a concurrent second accept (double-click / a second agent) no longer
// returns a conflict — the RPC serializes on the queue row and returns the
// already-promoted ids, so that case lands on the 200 ok path. The mappings the
// handler must still get right:
//   - still_needs_review     → 409 {error:"still_needs_review"} (distinct reason)
//   - any other error        → 500 (a genuine promote failure)
//   - ok                     → 200 with the promoted ids (fresh OR idempotent
//                              second accept — both look identical to the caller)

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PromoteResult } from "@/lib/import/promote";

const h = vi.hoisted(() => ({
  loadRow: null as Record<string, unknown> | null,
  promoteResult: { ok: true, status: "promoted", contact_id: "c-1", booking_id: "b-1", commission_id: "cm-1" } as PromoteResult,
  promoteImport: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => ({ ctx: { tenant_id: "tenant-1" }, user: { id: "user-1" } })),
}));
vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: vi.fn(() => Response.json({ error: "auth" }, { status: 403 })),
}));
vi.mock("@/lib/audit/write", () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock("@/lib/api/db-error-response", () => ({
  dbErrorResponse: vi.fn(() => Response.json({ error: "db" }, { status: 500 })),
}));
vi.mock("@/lib/import/match-statement-line-items", () => ({
  matchStatementLineItems: vi.fn(async () => ({})),
}));

vi.mock("@/lib/import/promote", () => ({ promoteImport: h.promoteImport }));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "update"]) chain[m] = () => chain;
      chain.maybeSingle = async () => ({ data: h.loadRow, error: null });
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: [{ id: "row-1" }], error: null });
      return chain;
    },
  }),
}));

import { POST } from "@/app/api/imports/review/[id]/accept/route";

function call() {
  const req = new Request("https://t.example.com/api/imports/review/row-1/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  return POST(req, { params: Promise.resolve({ id: "row-1" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  // A booking_confirmation row in pending_review → routes through promoteImport.
  h.loadRow = {
    id: "row-1",
    tenant_id: "tenant-1",
    status: "pending_review",
    raw_extracted_fields: {},
    document_type: "booking_confirmation",
  };
  h.promoteResult = { ok: true, status: "promoted", contact_id: "c-1", booking_id: "b-1", commission_id: "cm-1" };
  h.promoteImport.mockImplementation(async () => h.promoteResult);
});

describe("POST /api/imports/review/[id]/accept — promoter-result mapping (#1576/#1712)", () => {
  it("idempotent second accept (RPC returned already-promoted ids) → 200, not a conflict", async () => {
    // Post-#1712 a double-click no longer surfaces a conflict: the atomic RPC
    // returns the existing contact/booking, so promoteImport returns ok. The
    // handler must pass that straight through as 200 — a 409/500 here would be a
    // false failure for a promotion that actually succeeded.
    h.promoteResult = { ok: true, status: "already_accepted", contact_id: "c-1", booking_id: "b-1" };
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      accepted: true,
      contact_id: "c-1",
      booking_id: "b-1",
      commission_id: undefined,
    });
  });

  it("still_needs_review → 409 with its own reason", async () => {
    h.promoteResult = { ok: false, needs_review: true, reason: "commission_rate_missing" };
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string; reason: string }).toEqual({
      error: "still_needs_review",
      reason: "commission_rate_missing",
    });
  });

  it("any other promoter error → 500 (not collapsed into the 409 conflict)", async () => {
    h.promoteResult = { ok: false, error: "booking_insert_failed: boom" };
    const res = await call();
    expect(res.status).toBe(500);
    expect((await res.json()) as { error: string }).toEqual({ error: "booking_insert_failed: boom" });
  });

  it("ok → 200 with the promoted ids", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      accepted: true,
      contact_id: "c-1",
      booking_id: "b-1",
      commission_id: "cm-1",
    });
  });
});
