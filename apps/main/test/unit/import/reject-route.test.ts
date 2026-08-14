// #1330 — POST /api/imports/review/[id]/reject contracts.
//
// WHY these matter: an import that the pipeline can't parse (e.g. a scanned
// image-only PDF → parse_failed / no_text_available) was previously un-rejectable
// — the route only allowed pending_review, so the row sat stuck until the purge
// timer and the reviewer got `row_not_in_pending_review:parse_failed`. A reviewer
// must be able to discard a failed import. These tests pin:
//   - parse_failed IS rejectable (the bug fix) — and pending_review still is.
//   - other statuses are NOT (you can't reject an already-accepted row).
//   - the CAS guard reports a lost race as a conflict, never a false success.
//   - tenant isolation + reason-required are enforced before any write.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  permError: null as string | null,
  loadRow: null as Record<string, unknown> | null,
  updateMatched: [{ id: "row-1" }] as Array<{ id: string }>,
}));

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => {
    if (h.permError) throw new Error(h.permError);
    return { ctx: { tenant_id: "tenant-1" }, user: { id: "user-1" } };
  }),
}));
vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: vi.fn(() => Response.json({ error: "auth" }, { status: 403 })),
}));
vi.mock("@/lib/audit/write", () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock("@/lib/api/db-error-response", () => ({
  dbErrorResponse: vi.fn(() => Response.json({ error: "db" }, { status: 500 })),
}));

const updateSpy = vi.fn();

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: () => {
      let isUpdate = false;
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in"]) chain[m] = () => chain;
      chain.update = (patch: unknown) => {
        isUpdate = true;
        updateSpy(patch);
        return chain;
      };
      chain.maybeSingle = async () => ({ data: h.loadRow, error: null });
      // The update chain (…​.select("id")) is awaited by safeAwaitRowCount.
      chain.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: isUpdate ? h.updateMatched : null, error: null });
      return chain;
    },
  }),
}));

import { POST } from "@/app/api/imports/review/[id]/reject/route";

function call(body: Record<string, unknown> = { reason: "duplicate" }) {
  const req = new Request("https://t.example.com/api/imports/review/row-1/reject", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ id: "row-1" }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.permError = null;
  h.loadRow = { id: "row-1", tenant_id: "tenant-1", status: "parse_failed", document_type: null };
  h.updateMatched = [{ id: "row-1" }];
});

describe("POST /api/imports/review/[id]/reject (#1330)", () => {
  it("parse_failed row IS rejectable (the fix) — transitions to rejected", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()) as { rejected: boolean }).toEqual({ rejected: true });
    expect(updateSpy).toHaveBeenCalledOnce();
    expect(updateSpy.mock.calls[0]![0]).toMatchObject({ status: "rejected" });
  });

  it("pending_review row is still rejectable (no regression)", async () => {
    h.loadRow = { ...h.loadRow!, status: "pending_review" };
    expect((await call()).status).toBe(200);
  });

  it("a non-terminal/non-review status cannot be rejected → 409, no write", async () => {
    h.loadRow = { ...h.loadRow!, status: "accepted" };
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({ error: "row_not_rejectable:accepted" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("CAS lost race (zero rows matched) → 409 reject_conflict, not a false success", async () => {
    h.updateMatched = [];
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({ error: "reject_conflict" });
  });

  // @rls-covered-by apps/main/test/integration/rls.test.ts#import_queue: userB cannot SELECT tenantA rows
  it("cross-tenant row → 403 forbidden, no write", async () => {
    h.loadRow = { ...h.loadRow!, tenant_id: "tenant-2" };
    const res = await call();
    expect(res.status).toBe(403);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("missing reason → 400 before any load/write", async () => {
    expect((await call({})).status).toBe(400);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("permission failure → auth responder (403)", async () => {
    h.permError = "forbidden";
    expect((await call()).status).toBe(403);
  });
});
