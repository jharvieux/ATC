// #2050 — GET /api/imports/source-file signs storage paths from the DB row,
// never from the request.
//
// The route used to accept ?path=<storage path> and gate it with
// `path.startsWith(`${tenant_id}/`)` before signing with a service-role
// client. A prefix check is not a containment check: values like
// `<my-tenant>/../<other-tenant>/doc.pdf` pass it, and service-role bypasses
// storage RLS, so the prefix check was the ONLY tenant boundary. These tests
// pin the fix: the caller supplies an opaque import_queue id, the lookup is
// tenant-scoped, and the only path ever signed is the one stored on the row.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
  createSignedUrl: vi.fn(),
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
      select: () => ({
        eq: (...args: unknown[]) => {
          mocks.eq(...args);
          return { maybeSingle: mocks.maybeSingle };
        },
      }),
    }),
    storage: {
      from: () => ({ createSignedUrl: mocks.createSignedUrl }),
    },
  }),
}));

import { GET } from "@/app/api/imports/source-file/route";

function req(query: string): Request {
  return new Request(`http://test/api/imports/source-file${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: "t-1", source: { kind: "http_request", user_id: "u-1" } },
    user: { id: "u-1" },
  });
  mocks.maybeSingle.mockResolvedValue({
    data: { uploaded_file_path: "t-1/q-1.pdf" },
    error: null,
  });
  mocks.createSignedUrl.mockResolvedValue({
    data: { signedUrl: "https://storage.test/signed/t-1/q-1.pdf" },
    error: null,
  });
});

describe("GET /api/imports/source-file", () => {
  it("redirects to a signed URL for the path stored on the tenant's row", async () => {
    const res = await GET(req("?id=q-1"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://storage.test/signed/t-1/q-1.pdf");
    expect(mocks.eq).toHaveBeenCalledWith("id", "q-1");
    expect(mocks.createSignedUrl).toHaveBeenCalledWith("t-1/q-1.pdf", 300);
  });

  it("no longer accepts a caller-supplied path — the #2050 traversal shape gets a 400, nothing is signed", async () => {
    const res = await GET(req(`?path=${encodeURIComponent("t-1/../t-2/doc.pdf")}`));
    expect(res.status).toBe(400);
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
  });

  it("a path param alongside a valid id cannot influence what gets signed", async () => {
    const res = await GET(req(`?id=q-1&path=${encodeURIComponent("t-1/../t-2/doc.pdf")}`));
    expect(res.status).toBe(302);
    expect(mocks.createSignedUrl).toHaveBeenCalledTimes(1);
    expect(mocks.createSignedUrl).toHaveBeenCalledWith("t-1/q-1.pdf", 300);
  });

  // Cross-tenant scoping itself is tenantClient's contract (its own tests +
  // the mocked-tenant-tests guard forbid claiming it here against a mock).
  it("404s when the lookup finds no row, signing nothing", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await GET(req("?id=q-other-tenant"));
    expect(res.status).toBe(404);
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });

  it("404s when the row exists but has no uploaded file", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { uploaded_file_path: null }, error: null });
    const res = await GET(req("?id=q-1"));
    expect(res.status).toBe(404);
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });

  it("surfaces DB errors via dbErrorResponse", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    const res = await GET(req("?id=q-1"));
    expect(res.status).toBe(500);
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
  });
});
