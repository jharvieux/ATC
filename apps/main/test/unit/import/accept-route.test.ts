// #1576 — POST /api/imports/review/[id]/accept: promoter-result → HTTP mapping.
//
// WHY this matters: the CAS-claim in promoteImport can return
// {ok:false, error:"promotion_in_progress"} when a second concurrent accept
// (double-click / a second agent) already holds the claim. The handler MUST
// translate that specific result to 409 Conflict, not the generic 500 it gives
// every other error. A 500 would tell the caller "retry" — exactly the wrong
// signal for a live-in-flight promotion, and the double-write this whole fix
// exists to prevent. These tests pin that translation table at the boundary:
//   - promotion_in_progress → 409 {error:"promotion_in_progress"}
//   - still_needs_review     → 409 {error:"still_needs_review"} (distinct reason)
//   - any other error        → 500 (not silently collapsed into the 409)
//   - ok                     → 200 with the promoted ids

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PromoteResult } from "@/lib/import/promote";

const h = vi.hoisted(() => ({
  loadRow: null as Record<string, unknown> | null,
  promoteResult: { ok: true, contact_id: "c-1", booking_id: "b-1", commission_id: "cm-1" } as PromoteResult,
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
  h.promoteResult = { ok: true, contact_id: "c-1", booking_id: "b-1", commission_id: "cm-1" };
  h.promoteImport.mockImplementation(async () => h.promoteResult);
});

describe("POST /api/imports/review/[id]/accept — promoter-result mapping (#1576)", () => {
  it("promotion_in_progress → 409 conflict, not 500", async () => {
    h.promoteResult = { ok: false, error: "promotion_in_progress" };
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({ error: "promotion_in_progress" });
  });

  it("still_needs_review → 409 with its own reason (distinct from promotion_in_progress)", async () => {
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
