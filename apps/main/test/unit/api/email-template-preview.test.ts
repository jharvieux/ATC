// Tests for the email template preview, send-preview, and sailings-search routes.
//
// Intent under test:
// - Preview route returns HTML from the preview builder; unknown types get 400.
// - Send-preview route is owner-only (email_templates:write), rejects invalid
//   email addresses, enforces the 10/day per-tenant rate limit via email_log,
//   and returns 429 on limit breach.
// - Sailings-search returns an empty array for an empty query without hitting
//   the DB, and returns shaped results for a valid query.
// - The template_preview rate-limit branch in rate-limit.ts fails closed on
//   DB error and blocks after 10 sends in 24h.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Shared mock factories ─────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  // tenantClient mock chain: supports .from().select()...single/maybeSingle/etc.
  fromFn: vi.fn(),
  buildPreviewHtml: vi.fn(),
  renderOverrideBodyInLayout: vi.fn(),
  resolveEmailContent: vi.fn(),
  sendEmail: vi.fn(),
  createServiceRoleClient: vi.fn(),
  // rate-limit DB chain
  rlFromFn: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/auth/respond", () => ({
  respondToAuthError: (e: unknown) =>
    Response.json({ error: String(e) }, { status: 401 }),
}));

// tenantClient: any .from() call returns a chainable query builder.
vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({ from: mocks.fromFn }),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));

vi.mock("@/lib/email/preview-builder", () => ({
  buildPreviewHtml: mocks.buildPreviewHtml,
}));

vi.mock("@/lib/email/template-resolve", () => ({
  resolveEmailContent: mocks.resolveEmailContent,
  renderOverrideBodyInLayout: mocks.renderOverrideBodyInLayout,
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock("@/lib/api/db-error-response", () => ({
  dbErrorResponse: (e: unknown) => Response.json({ error: String(e) }, { status: 500 }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const OWNER_CTX = { tenant_id: "t-abc" };

function makeChain(overrides: Record<string, unknown> = {}) {
  const base = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides,
  };
  return base;
}

const params = (type: string) => ({ params: Promise.resolve({ type }) });

// ── Preview route ─────────────────────────────────────────────────────────────

import { GET as previewGET } from "@/app/api/tenant/email-templates/[type]/preview/route";

describe("GET /api/tenant/email-templates/[type]/preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertPermission.mockResolvedValue({ ctx: OWNER_CTX });
    mocks.buildPreviewHtml.mockResolvedValue("<html>preview</html>");
    mocks.resolveEmailContent.mockResolvedValue({
      subject: "Preview subject",
      overrideBodyText: null,
    });

    // Default tenant + branding chain.
    const tenantChain = makeChain({
      single: vi.fn().mockResolvedValue({
        data: { legal_name: "Acme Travel", mailing_address: "123 Main St" },
        error: null,
      }),
    });
    const brandingChain = makeChain({
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    });
    mocks.fromFn.mockImplementation((table: string) => {
      if (table === "tenants") return tenantChain;
      if (table === "tenant_branding") return brandingChain;
      return makeChain();
    });
  });

  it("returns 400 for an unknown template type", async () => {
    const req = new Request("http://test/api/tenant/email-templates/not_real/preview");
    const res = await previewGET(req, params("not_real"));
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toBe("unknown_template_type");
  });

  it("returns HTML from buildPreviewHtml when no tenant override exists", async () => {
    const req = new Request("http://test/api/tenant/email-templates/pre_cruise_t_90/preview");
    const res = await previewGET(req, params("pre_cruise_t_90"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toBe("<html>preview</html>");
    expect(mocks.buildPreviewHtml).toHaveBeenCalledWith(
      "pre_cruise_t_90",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("uses renderOverrideBodyInLayout when the tenant has a custom body", async () => {
    mocks.resolveEmailContent.mockResolvedValue({
      subject: "Custom subject",
      overrideBodyText: "Custom body text",
    });
    mocks.renderOverrideBodyInLayout.mockResolvedValue("<html>custom</html>");

    const req = new Request("http://test/api/tenant/email-templates/pre_cruise_t_90/preview");
    const res = await previewGET(req, params("pre_cruise_t_90"));
    expect(res.status).toBe(200);
    expect(mocks.renderOverrideBodyInLayout).toHaveBeenCalledWith(
      expect.any(Object),
      "Custom body text",
    );
    expect(mocks.buildPreviewHtml).not.toHaveBeenCalled();
  });

  it("overlays sailing variables when sailing_id is provided", async () => {
    const sailingChain = makeChain({
      single: vi.fn().mockResolvedValue({
        data: {
          departure_date: "2026-11-01",
          departure_port: "Miami, FL",
          cruise_ships: {
            canonical_name: "Wonder of the Seas",
            cruise_lines: { display_name: "Royal Caribbean" },
          },
        },
        error: null,
      }),
    });
    const tenantChain = makeChain({
      single: vi.fn().mockResolvedValue({
        data: { legal_name: "Acme Travel", mailing_address: "123 Main St" },
        error: null,
      }),
    });
    mocks.fromFn.mockImplementation((table: string) => {
      if (table === "cruise_sailings") return sailingChain;
      if (table === "tenants") return tenantChain;
      return makeChain();
    });

    const req = new Request(
      "http://test/api/tenant/email-templates/pre_cruise_t_90/preview?sailing_id=s-001",
    );
    const res = await previewGET(req, params("pre_cruise_t_90"));
    expect(res.status).toBe(200);
    expect(mocks.buildPreviewHtml).toHaveBeenCalledWith(
      "pre_cruise_t_90",
      expect.objectContaining({
        ship_name: "Wonder of the Seas",
        cruise_line: "Royal Caribbean",
        sailing_date: "2026-11-01",
        departure_port: "Miami, FL",
      }),
      expect.any(Object),
    );
  });

  it("returns 401 when the caller is not authenticated", async () => {
    mocks.assertPermission.mockRejectedValue(new Error("unauthenticated"));
    const req = new Request("http://test/api/tenant/email-templates/pre_cruise_t_90/preview");
    const res = await previewGET(req, params("pre_cruise_t_90"));
    expect(res.status).toBe(401);
  });
});

// ── Send-preview route ────────────────────────────────────────────────────────

import { POST as sendPreviewPOST } from "@/app/api/tenant/email-templates/[type]/send-preview/route";

function sendReq(body: unknown) {
  return new Request("http://test/api/tenant/email-templates/pre_cruise_t_90/send-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tenant/email-templates/[type]/send-preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertPermission.mockResolvedValue({
      ctx: OWNER_CTX,
      user: { id: "u-owner", role: "tenant_owner" },
    });
    mocks.createServiceRoleClient.mockReturnValue({ _svc: true });
    mocks.sendEmail.mockResolvedValue({ status: "sent" });
    mocks.buildPreviewHtml.mockResolvedValue("<html>preview</html>");
    mocks.resolveEmailContent.mockResolvedValue({
      subject: "Great cruise!",
      overrideBodyText: null,
    });

    const tenantChain = makeChain({
      single: vi.fn().mockResolvedValue({
        data: {
          id: "t-abc",
          legal_name: "Acme Travel",
          mailing_address: "123 Main St",
        },
        error: null,
      }),
    });
    mocks.fromFn.mockImplementation((table: string) => {
      if (table === "tenants") return tenantChain;
      return makeChain();
    });
  });

  it("returns 400 for an unknown template type", async () => {
    const res = await sendPreviewPOST(
      sendReq({ to_email: "test@example.com" }),
      params("not_real"),
    );
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toBe("unknown_template_type");
  });

  it("returns 400 when to_email is missing", async () => {
    const res = await sendPreviewPOST(sendReq({}), params("pre_cruise_t_90"));
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toBe("invalid_to_email");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed email address", async () => {
    const res = await sendPreviewPOST(
      sendReq({ to_email: "not-an-email" }),
      params("pre_cruise_t_90"),
    );
    expect(res.status).toBe(400);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("returns 401 when caller is unauthenticated", async () => {
    mocks.assertPermission.mockRejectedValue(new Error("unauthenticated"));
    const res = await sendPreviewPOST(
      sendReq({ to_email: "test@example.com" }),
      params("pre_cruise_t_90"),
    );
    expect(res.status).toBe(401);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("coerces a JSONB-object mailing_address before render (no 500 from the email-templates screen) (#1553)", async () => {
    // The tenants row stores mailing_address as JSONB {line1,city,...}. Passed
    // raw into the layout it would throw "Objects are not valid as a React child"
    // and 500 the send-test. The route must format it to a flat string first.
    const objAddrChain = makeChain({
      single: vi.fn().mockResolvedValue({
        data: {
          id: "t-abc",
          legal_name: "Acme Travel",
          mailing_address: { line1: "1 Main St", city: "Miami", state: "FL", zip: "33101", country: "US" },
        },
        error: null,
      }),
    });
    mocks.fromFn.mockImplementation((table: string) => {
      if (table === "tenants") return objAddrChain;
      return makeChain();
    });

    const res = await sendPreviewPOST(
      sendReq({ to_email: "agent@example.com" }),
      params("pre_cruise_t_90"),
    );
    expect(res.status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalled();
    // layout is buildPreviewHtml's 3rd arg; its address must be the flat string.
    const layoutArg = mocks.buildPreviewHtml.mock.calls[0]?.[2] as { tenant_business_address: string };
    expect(layoutArg.tenant_business_address).toBe("1 Main St, Miami, FL 33101, US");
  });

  it("calls sendEmail with the service-role client and [Preview] subject prefix", async () => {
    const res = await sendPreviewPOST(
      sendReq({ to_email: "agent@example.com" }),
      params("pre_cruise_t_90"),
    );
    expect(res.status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        db: { _svc: true },
        to: "agent@example.com",
        subject: "[Preview] Great cruise!",
        category: "template_preview",
        template_id: "template_preview",
      }),
    );
  });

  it("returns 429 when sendEmail returns rate_limited", async () => {
    mocks.sendEmail.mockResolvedValue({
      status: "rate_limited",
      reason: "template_preview_daily_limit_reached",
    });
    const res = await sendPreviewPOST(
      sendReq({ to_email: "agent@example.com" }),
      params("pre_cruise_t_90"),
    );
    expect(res.status).toBe(429);
  });

  it("returns 500 when sendEmail returns failed", async () => {
    mocks.sendEmail.mockResolvedValue({ status: "failed", reason: "resend_error" });
    const res = await sendPreviewPOST(
      sendReq({ to_email: "agent@example.com" }),
      params("pre_cruise_t_90"),
    );
    expect(res.status).toBe(500);
  });
});

// ── Sailings-search route ─────────────────────────────────────────────────────

import { GET as sailingsGET } from "@/app/api/tenant/email-templates/sailings-search/route";

describe("GET /api/tenant/email-templates/sailings-search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertPermission.mockResolvedValue({ ctx: OWNER_CTX });
  });

  it("returns an empty array without hitting the DB when q is blank", async () => {
    const req = new Request("http://test/api/tenant/email-templates/sailings-search?q=");
    const res = await sailingsGET(req);
    expect(res.status).toBe(200);
    const data = await res.json() as { sailings: unknown[] };
    expect(data.sailings).toEqual([]);
    expect(mocks.fromFn).not.toHaveBeenCalled();
  });

  it("returns 401 when caller is unauthenticated", async () => {
    mocks.assertPermission.mockRejectedValue(new Error("unauthenticated"));
    const req = new Request("http://test/api/tenant/email-templates/sailings-search?q=Wonder");
    const res = await sailingsGET(req);
    expect(res.status).toBe(401);
  });

  it("returns shaped sailing results including ship_name and cruise_line_name", async () => {
    const shipsChain = makeChain({
      limit: vi.fn().mockResolvedValue({
        data: [
          {
            id: "ship-1",
            canonical_name: "Wonder of the Seas",
            cruise_lines: { display_name: "Royal Caribbean" },
          },
        ],
        error: null,
      }),
    });
    const sailingsChain = makeChain({
      limit: vi.fn().mockResolvedValue({
        data: [
          {
            id: "s-001",
            departure_date: "2026-11-01",
            departure_port: "Miami, FL",
            duration_nights: 7,
            cruise_ship_id: "ship-1",
          },
        ],
        error: null,
      }),
    });
    mocks.fromFn.mockImplementation((table: string) => {
      if (table === "cruise_ships") return shipsChain;
      if (table === "cruise_sailings") return sailingsChain;
      return makeChain();
    });

    const req = new Request("http://test/api/tenant/email-templates/sailings-search?q=Wonder");
    const res = await sailingsGET(req);
    expect(res.status).toBe(200);
    const data = await res.json() as { sailings: unknown[] };
    expect(data.sailings).toHaveLength(1);
    expect(data.sailings[0]).toMatchObject({
      id: "s-001",
      ship_name: "Wonder of the Seas",
      cruise_line_name: "Royal Caribbean",
      departure_date: "2026-11-01",
    });
  });

  it("returns an empty array when no ships match the query", async () => {
    const shipsChain = makeChain({
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    });
    mocks.fromFn.mockImplementation(() => shipsChain);

    const req = new Request("http://test/api/tenant/email-templates/sailings-search?q=NoMatch");
    const res = await sailingsGET(req);
    const data = await res.json() as { sailings: unknown[] };
    expect(data.sailings).toEqual([]);
  });
});

// ── template_preview rate-limit branch ───────────────────────────────────────

import { checkRateLimit } from "@/lib/email/rate-limit";

describe("checkRateLimit — template_preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeRlDb(rowCount: number, error: null | { message: string } = null) {
    const chain = makeChain({
      not: vi.fn().mockResolvedValue({ data: Array(rowCount).fill({ id: "x" }), error }),
    });
    return { from: () => chain } as unknown as import("@supabase/supabase-js").SupabaseClient;
  }

  it("allows the send when fewer than 10 previews have been sent today", async () => {
    const result = await checkRateLimit({
      db: makeRlDb(5),
      tenant_id: "t-abc",
      to_email: "agent@example.com",
      category: "template_preview",
    });
    expect(result.allowed).toBe(true);
  });

  it("blocks the send when exactly 10 previews have been sent today", async () => {
    const result = await checkRateLimit({
      db: makeRlDb(10),
      tenant_id: "t-abc",
      to_email: "agent@example.com",
      category: "template_preview",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("template_preview_daily_limit_reached");
  });

  it("fails closed (allowed: false) when the rate-limit DB query errors", async () => {
    const result = await checkRateLimit({
      db: makeRlDb(0, { message: "connection error" }),
      tenant_id: "t-abc",
      to_email: "agent@example.com",
      category: "template_preview",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("rate_limit_query_failed");
  });
});
