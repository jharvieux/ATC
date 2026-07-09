// #1674 — PR #1633 (error-sanitization sweep, #1594) changed this route's
// non-Error fallback from String(err) to "" before status-mapping, with zero
// test coverage. These tests pin the error-status-mapping in the catch:
//   - a known Error message maps to its specific 4xx
//   - a NON-Error thrown value falls through to a sanitized 500 db_error
//     (the "" fallback — the whole point of #1594: never echo raw thrown text)
//   - the pre-audit validation branches keep their status codes

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  tenantRow: null as Record<string, unknown> | null,
  tierRow: null as Record<string, unknown> | null,
  collisionRow: null as Record<string, unknown> | null,
  updateError: null as { message: string } | null,
  auditThrows: null as unknown, // set to a NON-Error value to exercise the "" fallback
}));

vi.mock("@/lib/auth/assert-platform-admin", () => ({
  assertPlatformAdminArea: async () => ({ admin_user_id: "admin-1" }),
  PlatformAdminError: class extends Error {},
}));

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: async (
    _opts: unknown,
    fn: (db: unknown, recordQuery: () => void) => Promise<unknown>,
  ) => {
    if (h.auditThrows !== null) throw h.auditThrows;
    const db = {
      from: (table: string) => {
        if (table === "tenants") {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: h.tenantRow,
                  error: h.tenantRow ? null : { message: "no rows" },
                }),
                neq: () => ({
                  maybeSingle: async () => ({ data: h.collisionRow, error: null }),
                }),
              }),
            }),
            update: () => ({ eq: async () => ({ error: h.updateError }) }),
          };
        }
        if (table === "tier_definitions") {
          return {
            select: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: h.tierRow, error: null }) }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    };
    return fn(db, () => {});
  },
}));

import { POST } from "@/app/api/admin/tenants/[id]/custom-domain/route";

function post(body: unknown, domain = "travel.example.com"): Promise<Response> {
  const payload = body ?? { custom_domain: domain };
  return POST(
    new Request("https://app.example.com/api/admin/tenants/t-1/custom-domain", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(payload),
    }),
    { params: Promise.resolve({ id: "t-1" }) },
  );
}

beforeEach(() => {
  h.tenantRow = { id: "t-1", tier_id: "tier-1", custom_domain: null };
  h.tierRow = { code: "sub_agency" };
  h.collisionRow = null;
  h.updateError = null;
  h.auditThrows = null;
});

describe("custom-domain — error-status mapping in the catch (#1674)", () => {
  it("maps a tenant_not_found Error to 404", async () => {
    h.tenantRow = null;
    const res = await post(undefined);
    expect(res.status).toBe(404);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("tenant_not_found");
  });

  it("maps tier_not_eligible_for_custom_domain to 403", async () => {
    h.tierRow = { code: "basic" };
    const res = await post(undefined);
    expect(res.status).toBe(403);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("tier_not_eligible_for_custom_domain");
  });

  it("maps domain_already_claimed to 409", async () => {
    h.collisionRow = { id: "other-tenant" };
    const res = await post(undefined);
    expect(res.status).toBe(409);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("domain_already_claimed");
  });

  it("returns 200 with DNS records on success", async () => {
    const res = await post(undefined);
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; dns_records: { cname: unknown; txt: unknown } };
    expect(json.ok).toBe(true);
    expect(json.dns_records.cname).toBeTruthy();
    expect(json.dns_records.txt).toBeTruthy();
  });

  it("a NON-Error thrown value falls through to a sanitized 500 (the '' fallback)", async () => {
    // Pre-#1594 this used String(err); #1594 changed it to "" so an object/
    // string thrown deep in the stack can't be echoed. It must land on the
    // generic db_error, never a branch keyed on its stringified text.
    h.auditThrows = { weird: "not-an-error", secret: "postgres://leak" };
    const res = await post(undefined);
    expect(res.status).toBe(500);
    const json = await res.json() as Record<string, unknown>;
    expect(json.error).toBe("db_error");
    expect(JSON.stringify(json)).not.toContain("postgres://leak");
  });

  it("a raw updateErr Error message falls through to 500 db_error (not echoed)", async () => {
    h.updateError = { message: "duplicate key value violates unique constraint" };
    const res = await post(undefined);
    expect(res.status).toBe(500);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("db_error");
    expect(JSON.stringify(json)).not.toContain("duplicate key");
  });
});

describe("custom-domain — pre-audit validation (#1674)", () => {
  it("rejects an apex domain with 422 invalid_domain", async () => {
    const res = await post({ custom_domain: "example.com" });
    expect(res.status).toBe(422);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("invalid_domain");
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await post("not json{");
    expect(res.status).toBe(400);
  });
});
