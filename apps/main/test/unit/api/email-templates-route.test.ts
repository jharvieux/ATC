// #963 — PUT/DELETE /api/tenant/email-templates/[type].
//
// Intent under test: the SAVE endpoint is the enforcement point for the
// "unknown variable rejected at save time, not send time" acceptance
// criterion. Auth gating (owner-only email_templates:write) is enforced by
// assertPermission against the grants matrix.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  upsert: vi.fn(),
  deleteEq: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: () => ({
      upsert: mocks.upsert,
      delete: () => ({ eq: mocks.deleteEq }),
    }),
  }),
}));

import { PUT, DELETE } from "@/app/api/tenant/email-templates/[type]/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: "t-1" },
    user: { id: "u-owner", role: "tenant_owner" },
  });
  mocks.upsert.mockResolvedValue({ data: null, error: null });
  mocks.deleteEq.mockResolvedValue({ data: null, error: null });
});

function putReq(body: unknown): Request {
  return new Request("http://test/api/tenant/email-templates/pre_cruise_t_90", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const props = (type: string) => ({ params: Promise.resolve({ type }) });

describe("PUT /api/tenant/email-templates/[type]", () => {
  it("rejects an override referencing an unknown variable with 400 + the offending name", async () => {
    const res = await PUT(putReq({ subject_template: "Hi {{custmer_name}}" }), props("pre_cruise_t_90"));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string; issues: { detail: string }[] };
    expect(data.error).toBe("invalid_template");
    expect(data.issues[0]!.detail).toContain("custmer_name");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects malformed braces with 400", async () => {
    const res = await PUT(putReq({ body_template: "Hi {{customer_name}" }), props("pre_cruise_t_90"));
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("upserts a valid override keyed on (tenant_id, email_type)", async () => {
    const res = await PUT(
      putReq({ subject_template: "Hi {{customer_name}}", body_template: "Sails {{sailing_date}}." }),
      props("pre_cruise_t_90"),
    );
    expect(res.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        email_type: "pre_cruise_t_90",
        subject_template: "Hi {{customer_name}}",
        body_template: "Sails {{sailing_date}}.",
        updated_by: "u-owner",
      }),
      { onConflict: "tenant_id,email_type" },
    );
  });

  // #975 — {{ai_content}} lets a pre-cruise override position the AI-generated
  // sections instead of replacing them. It is body-only (the value is
  // multi-paragraph text) and only valid on types that have AI content.
  it("accepts {{ai_content}} in a pre-cruise BODY override", async () => {
    const res = await PUT(
      putReq({ body_template: "Welcome aboard!\n\n{{ai_content}}\n\nSee you soon." }),
      props("pre_cruise_t_90"),
    );
    expect(res.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalled();
  });

  it("rejects {{ai_content}} in a SUBJECT (multi-paragraph value can't be a subject line)", async () => {
    const res = await PUT(putReq({ subject_template: "News: {{ai_content}}" }), props("pre_cruise_t_90"));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { issues: { detail: string }[] };
    expect(data.issues[0]!.detail).toContain("ai_content");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects {{ai_content}} in the body of a type with no AI content", async () => {
    const res = await PUT(putReq({ body_template: "Hi {{invitee_name}}, {{ai_content}}" }), props("group_reminder"));
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("returns 404 for an email type not in the registry", async () => {
    const res = await PUT(putReq({ subject_template: "x" }), props("not_a_real_type"));
    expect(res.status).toBe(404);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects an all-empty override with 400 (reset is DELETE, not blank-out)", async () => {
    const res = await PUT(putReq({ subject_template: "  ", body_template: null }), props("pre_cruise_t_90"));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("empty_override");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/tenant/email-templates/[type]", () => {
  it("deletes the override row for the type (reset to platform default)", async () => {
    const res = await DELETE(
      new Request("http://test/api/tenant/email-templates/group_reminder", { method: "DELETE" }),
      props("group_reminder"),
    );
    expect(res.status).toBe(200);
    expect(mocks.deleteEq).toHaveBeenCalledWith("email_type", "group_reminder");
  });

  it("returns 404 for an unknown type", async () => {
    const res = await DELETE(
      new Request("http://test/api/tenant/email-templates/nope", { method: "DELETE" }),
      props("nope"),
    );
    expect(res.status).toBe(404);
    expect(mocks.deleteEq).not.toHaveBeenCalled();
  });
});
