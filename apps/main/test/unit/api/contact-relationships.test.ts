// §12.2 — GET /api/crm/contacts/[id]/relationships (#1065).
//
// Intent under test:
//   1. GET returns the relationship list for a contact scoped to the tenant.
//   2. GET on a contact with no relationships returns an empty array (not 404).
//   3. POST creates a relationship with a valid canonical type.
//   4. POST rejects an unknown to_contact_id format (non-UUID) with 400.
//   5. POST returns 409 when the relationship already exists (unique constraint).
//   6. DELETE removes the relationship and returns 204.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  dbSelect: vi.fn(),
  dbInsert: vi.fn(),
  dbDelete: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

// Tenant client: chains that GET uses — .select().eq().order()
// POST uses — .insert().select().single()
// DELETE uses — .delete().eq().eq()
vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      if (table !== "contact_relationships") return {};
      return {
        select: () => ({
          eq: () => ({
            order: () => mocks.dbSelect(),
            single: () => mocks.dbInsert(),
          }),
          single: () => mocks.dbInsert(),
        }),
        insert: () => ({
          select: () => ({
            single: () => mocks.dbInsert(),
          }),
        }),
        delete: () => ({
          eq: () => ({
            eq: () => mocks.dbDelete(),
          }),
        }),
      };
    },
  }),
}));

const CTX = { tenant_id: "t-1", user_id: "u-1" };

function makeGetReq(contactId: string) {
  return new Request(`http://localhost/api/crm/contacts/${contactId}/relationships`);
}

function makePostReq(contactId: string, body: unknown) {
  return new Request(`http://localhost/api/crm/contacts/${contactId}/relationships`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeDeleteReq(contactId: string, relId: string) {
  return new Request(`http://localhost/api/crm/contacts/${contactId}/relationships/${relId}`, {
    method: "DELETE",
  });
}

const CONTACT_ID = "c0000000-0000-0000-0000-000000000001";
const REL_ID = "r0000000-0000-0000-0000-000000000001";
const OTHER_CONTACT_ID = "c0000000-0000-0000-0000-000000000002";

describe("GET /api/crm/contacts/[id]/relationships", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertPermission.mockResolvedValue({ ctx: CTX, user: { id: CTX.user_id } });
  });

  it("returns the relationship list for the contact", async () => {
    const row = {
      id: REL_ID,
      to_contact_id: OTHER_CONTACT_ID,
      relationship_type: "spouse",
      notes: null,
      source: "manual",
      confidence: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    mocks.dbSelect.mockResolvedValue({ data: [row], error: null });

    const { GET } = await import("@/app/api/crm/contacts/[id]/relationships/route");
    const res = await GET(makeGetReq(CONTACT_ID), {
      params: Promise.resolve({ id: CONTACT_ID }),
    });

    expect(res.status).toBe(200);
    const body: { relationships: unknown[] } = await res.json();
    expect(body.relationships).toHaveLength(1);
    expect(body.relationships[0]).toMatchObject({ relationship_type: "spouse" });
  });

  it("returns empty array when no relationships exist", async () => {
    mocks.dbSelect.mockResolvedValue({ data: [], error: null });

    const { GET } = await import("@/app/api/crm/contacts/[id]/relationships/route");
    const res = await GET(makeGetReq(CONTACT_ID), {
      params: Promise.resolve({ id: CONTACT_ID }),
    });

    expect(res.status).toBe(200);
    const body: { relationships: unknown[] } = await res.json();
    expect(body.relationships).toEqual([]);
  });
});

describe("POST /api/crm/contacts/[id]/relationships", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertPermission.mockResolvedValue({ ctx: CTX, user: { id: CTX.user_id } });
  });

  it("creates a relationship with a canonical type", async () => {
    const created = {
      id: REL_ID,
      from_contact_id: CONTACT_ID,
      to_contact_id: OTHER_CONTACT_ID,
      relationship_type: "spouse",
    };
    mocks.dbInsert.mockResolvedValue({ data: created, error: null });

    const { POST } = await import("@/app/api/crm/contacts/[id]/relationships/route");
    const res = await POST(
      makePostReq(CONTACT_ID, { to_contact_id: OTHER_CONTACT_ID, relationship_type: "spouse" }),
      { params: Promise.resolve({ id: CONTACT_ID }) },
    );

    expect(res.status).toBe(201);
    const body: { relationship_type: string } = await res.json();
    expect(body.relationship_type).toBe("spouse");
  });

  it("rejects a non-UUID to_contact_id with 400", async () => {
    const { POST } = await import("@/app/api/crm/contacts/[id]/relationships/route");
    const res = await POST(
      makePostReq(CONTACT_ID, { to_contact_id: "not-a-uuid", relationship_type: "friend" }),
      { params: Promise.resolve({ id: CONTACT_ID }) },
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 when relationship already exists (unique constraint)", async () => {
    mocks.dbInsert.mockResolvedValue({ data: null, error: { code: "23505", message: "unique" } });

    const { POST } = await import("@/app/api/crm/contacts/[id]/relationships/route");
    const res = await POST(
      makePostReq(CONTACT_ID, { to_contact_id: OTHER_CONTACT_ID, relationship_type: "sibling" }),
      { params: Promise.resolve({ id: CONTACT_ID }) },
    );
    expect(res.status).toBe(409);
    const body: { error: string } = await res.json();
    expect(body.error).toBe("relationship_already_exists");
  });
});

describe("DELETE /api/crm/contacts/[id]/relationships/[rel_id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertPermission.mockResolvedValue({ ctx: CTX, user: { id: CTX.user_id } });
  });

  it("removes the relationship and returns 204", async () => {
    mocks.dbDelete.mockResolvedValue({ error: null });

    const { DELETE } = await import("@/app/api/crm/contacts/[id]/relationships/[rel_id]/route");
    const res = await DELETE(makeDeleteReq(CONTACT_ID, REL_ID), {
      params: Promise.resolve({ id: CONTACT_ID, rel_id: REL_ID }),
    });
    expect(res.status).toBe(204);
  });
});
