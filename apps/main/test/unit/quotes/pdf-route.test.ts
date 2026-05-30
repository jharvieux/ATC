// §12.4 / §38.5 — GET /api/quotes/[id]/pdf (#451).
//
// Contracts pinned here:
//   1. Returns application/pdf with Content-Disposition: attachment so
//      browsers download instead of inlining (some PDFs render in-tab,
//      which is wrong for "Download PDF" UX).
//   2. No status gate: the agent can download at any quote stage; /send's
//      "draft only" guard is /send-specific and must not bleed in.
//   3. Loader failure modes (404 / 500) and enrich failure modes (500
//      from tenant/host lookups) propagate as structured errors — no
//      silent fallback to a stub PDF.
//   4. Cache-Control private,no-store so a freshly-edited quote doesn't
//      serve a stale buffer to the agent.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  loadQuoteRow: vi.fn(),
  buildRenderInputFromQuote: vi.fn(),
  renderQuotePdf: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
      "@/lib/auth/assert-permission",
    );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/quotes/build-render-input", () => ({
  loadQuoteRow: mocks.loadQuoteRow,
  buildRenderInputFromQuote: mocks.buildRenderInputFromQuote,
}));

vi.mock("@/lib/quotes/render-quote-pdf", () => ({
  renderQuotePdf: mocks.renderQuotePdf,
}));

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({ from: () => ({}) }),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({ from: () => ({}) }),
}));

import { GET } from "@/app/api/quotes/[id]/pdf/route";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID, source: { kind: "http_request", user_id: "u1" } },
    user: { id: "u1", auth_user_id: "auth-1", tenant_id: TENANT_ID, status: "active", role: "agent" },
  });
  mocks.renderQuotePdf.mockResolvedValue(Buffer.from("%PDF-1.4 fake"));
});

function req(): Request {
  return new Request("https://tenant.example.com/api/quotes/quote-1/pdf");
}

const PARAMS = { params: Promise.resolve({ id: "quote-1" }) };

const HAPPY_QUOTE = { id: "quote-1", status: "draft" };

describe("GET /api/quotes/[id]/pdf", () => {
  it("streams application/pdf with attachment Content-Disposition + no-store cache", async () => {
    mocks.loadQuoteRow.mockResolvedValue({ ok: true, quote: HAPPY_QUOTE });
    mocks.buildRenderInputFromQuote.mockResolvedValue({
      ok: true,
      input: { quote_id: "quote-1" },
    });
    const res = await GET(req(), PARAMS);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain(
      'attachment; filename="quote-quote-1.pdf"',
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("does NOT gate on status — agent can download at any stage (sent, accepted, etc.)", async () => {
    mocks.loadQuoteRow.mockResolvedValue({
      ok: true,
      quote: { id: "quote-1", status: "accepted" },
    });
    mocks.buildRenderInputFromQuote.mockResolvedValue({
      ok: true,
      input: { quote_id: "quote-1" },
    });
    const res = await GET(req(), PARAMS);
    expect(res.status).toBe(200);
  });

  it("propagates loader 404 without calling buildRenderInputFromQuote or renderQuotePdf", async () => {
    mocks.loadQuoteRow.mockResolvedValue({
      ok: false,
      status: 404,
      message: "not_found",
    });
    const res = await GET(req(), PARAMS);
    expect(res.status).toBe(404);
    expect(mocks.buildRenderInputFromQuote).not.toHaveBeenCalled();
    expect(mocks.renderQuotePdf).not.toHaveBeenCalled();
  });

  it("propagates loader 500 (quote SELECT DB error) without rendering a stub PDF", async () => {
    mocks.loadQuoteRow.mockResolvedValue({
      ok: false,
      status: 500,
      message: "connection refused",
    });
    const res = await GET(req(), PARAMS);
    expect(res.status).toBe(500);
    expect(mocks.renderQuotePdf).not.toHaveBeenCalled();
  });

  it("propagates enrich 500 (tenant/host lookup error) without rendering", async () => {
    mocks.loadQuoteRow.mockResolvedValue({ ok: true, quote: HAPPY_QUOTE });
    mocks.buildRenderInputFromQuote.mockResolvedValue({
      ok: false,
      status: 500,
      message: "tenant lookup: rls",
    });
    const res = await GET(req(), PARAMS);
    expect(res.status).toBe(500);
    expect(mocks.renderQuotePdf).not.toHaveBeenCalled();
  });

  it("delegates auth errors to respondToAuthError (401 for invalid session)", async () => {
    mocks.assertPermission.mockRejectedValue(
      new Error("assertPermission: invalid or expired access token."),
    );
    const res = await GET(req(), PARAMS);
    expect(res.status).toBe(401);
  });
});
