// §20.7 / #1883 — the accepted-quote PDF carries the tenant-of-record legal
// disclosure. This pins the fail-open-disclosure fix: a missing sub-host
// display_name or host-agency legal name must FAIL the acceptance with a
// client-distinguishable error (422 disclosure_unavailable), never render a
// fabricated "Sub-host" / "Host Agency" placeholder into the customer's
// dispute-defense document. Same class #1856 fixed for the Booking Review stage.
//
// The test fails if a placeholder fallback is reintroduced (acceptance would
// succeed with 200 instead of 422), or if the disclosure gate stops running
// before the PDF render / status flip.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  renderQuotePdfHtml: vi.fn(),
  writeAuditLog: vi.fn(),
  triggerMatchingSequences: vi.fn(),
  tenantMaybeSingle: vi.fn(),
  hostMaybeSingle: vi.fn(),
  quotesUpdateSingle: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/quotes/render-pdf", () => ({
  renderQuotePdfHtml: mocks.renderQuotePdfHtml,
}));

vi.mock("@/lib/audit/write", () => ({ writeAuditLog: mocks.writeAuditLog }));

vi.mock("@/lib/tasks/sequence-engine", () => ({
  triggerMatchingSequences: mocks.triggerMatchingSequences,
}));

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const QUOTE_ID = "quote-1";

const QUOTE_ROW = {
  id: QUOTE_ID,
  tenant_id: TENANT_ID,
  status: "sent",
  price_kind: "estimate" as const,
  priced_at: "2026-05-30T12:00:00Z",
  price_lock_token: null,
  price_lock_expires_at: null,
  estimate_price_cents: 120000,
  locked_price_cents: null,
  contact_id: null,
  user_id: "u1",
};

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    from: (table: string) => {
      if (table === "tenant_settings") {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
      }
      if (table === "quote_options") {
        return { select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) };
      }
      // "quotes" — initial read + CAS update
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: QUOTE_ROW, error: null }) }) }),
        update: () => ({
          eq: () => ({
            in: () => ({
              select: () => ({ single: () => mocks.quotesUpdateSingle() }),
            }),
          }),
        }),
      };
    },
  }),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "tenants") {
        return { select: () => ({ eq: () => ({ maybeSingle: mocks.tenantMaybeSingle }) }) };
      }
      // platform_settings
      return { select: () => ({ eq: () => ({ maybeSingle: mocks.hostMaybeSingle }) }) };
    },
  }),
}));

import { POST } from "@/app/api/quotes/[id]/accept/route";

const PARAMS = { params: Promise.resolve({ id: QUOTE_ID }) };

function req(): Request {
  return new Request(`https://tenant.example.com/api/quotes/${QUOTE_ID}/accept`, { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID, source: { kind: "http_request", user_id: "u1" } },
    user: { id: "u1", auth_user_id: "auth-1", tenant_id: TENANT_ID, status: "active", role: "agent" },
  });
  mocks.renderQuotePdfHtml.mockReturnValue({ html: "<!doctype html><html></html>", content_hash: "h" });
  mocks.writeAuditLog.mockResolvedValue(undefined);
  mocks.triggerMatchingSequences.mockResolvedValue(undefined);
  mocks.quotesUpdateSingle.mockResolvedValue({ data: { ...QUOTE_ROW, status: "accepted" }, error: null });
  // Happy default: both disclosure fields resolvable.
  mocks.tenantMaybeSingle.mockResolvedValue({ data: { display_name: "Acme Travel", support_email: "h@a.example" }, error: null });
  mocks.hostMaybeSingle.mockResolvedValue({ data: { value: "Travel Pros LLC" }, error: null });
});

describe("accept route — §20.7 disclosure fail-closed (#1883)", () => {
  it("accepts when both the sub-host name and host-agency legal name resolve", async () => {
    const res = await POST(req(), PARAMS);
    expect(res.status).toBe(200);
    // The disclosure fed the render with real values, not placeholders.
    const input = mocks.renderQuotePdfHtml.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.tenant_name).toBe("Acme Travel");
    expect(input.host_agency_legal_name).toBe("Travel Pros LLC");
  });

  it("422 disclosure_unavailable (no placeholder, no PDF, no accept) when the host-agency row is missing", async () => {
    mocks.hostMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await POST(req(), PARAMS);
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toBe("disclosure_unavailable");
    // The acceptance never proceeded to render or flip the quote.
    expect(mocks.renderQuotePdfHtml).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
    expect(mocks.quotesUpdateSingle).not.toHaveBeenCalled();
  });

  it("422 disclosure_unavailable when platform_settings.value is a malformed object (never 'Host Agency')", async () => {
    mocks.hostMaybeSingle.mockResolvedValue({ data: { value: {} }, error: null });
    const res = await POST(req(), PARAMS);
    expect(res.status).toBe(422);
    expect(mocks.renderQuotePdfHtml).not.toHaveBeenCalled();
  });

  it("422 disclosure_unavailable when the sub-host tenant display_name is missing (never 'Sub-host')", async () => {
    mocks.tenantMaybeSingle.mockResolvedValue({ data: { display_name: null, support_email: null }, error: null });
    const res = await POST(req(), PARAMS);
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toBe("disclosure_unavailable");
    expect(mocks.renderQuotePdfHtml).not.toHaveBeenCalled();
  });
});
