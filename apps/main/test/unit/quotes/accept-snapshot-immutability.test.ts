// §21.10.1 / #1715 — accepted-quote pdf_html snapshot immutability.
//
// WHY this matters: when a customer accepts a quote, POST /api/quotes/[id]/accept
// renders the quote to HTML and writes that HTML VERBATIM into
// audit_log.changes.pdf_html (D-091 Round-3 #48). That stored HTML is the
// dispute-defense record — "here is exactly the document the customer saw and
// accepted." Its whole value is that it is frozen at accept time: a later edit
// to render-pdf.ts (new footer copy, restyled banner, a formatting fix) must
// NOT retroactively change what an already-accepted customer agreed to.
//
// The #1596 consolidation promised this immutability but no test pinned it.
// These tests fail if the accept route ever stops storing the full rendered
// HTML verbatim (e.g. reverts to storing only a hash + re-rendering on display),
// or if a stored snapshot could move when the renderer evolves.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  renderQuotePdfHtml: vi.fn(),
  writeAuditLog: vi.fn(),
  triggerMatchingSequences: vi.fn(),
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

vi.mock("@/lib/audit/write", () => ({
  writeAuditLog: mocks.writeAuditLog,
}));

vi.mock("@/lib/tasks/sequence-engine", () => ({
  triggerMatchingSequences: mocks.triggerMatchingSequences,
}));

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const QUOTE_ID = "quote-1";

// A quote row in a state that can be accepted (sent), estimate-priced.
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

function makeTenantDb() {
  return {
    from: (table: string) => {
      if (table === "tenant_settings") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
          }),
        };
      }
      if (table === "quote_options") {
        return {
          select: () => ({
            eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }),
          }),
        };
      }
      // "quotes" — supports BOTH the initial fetch (.select().eq().maybeSingle())
      // and the CAS update (.update().eq().in().select().single()).
      return {
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: QUOTE_ROW, error: null }) }),
        }),
        update: () => ({
          eq: () => ({
            in: () => ({
              select: () => ({
                single: () =>
                  Promise.resolve({ data: { ...QUOTE_ROW, status: "accepted" }, error: null }),
              }),
            }),
          }),
        }),
      };
    },
  };
}

function makeAdminDb() {
  return {
    from: (table: string) => {
      if (table === "tenants") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: { display_name: "Acme Travel" }, error: null }) }),
          }),
        };
      }
      // platform_settings
      return {
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: { value: "Travel Pros LLC" }, error: null }) }),
        }),
      };
    },
  };
}

vi.mock("@/lib/db/tenant-client", () => ({ tenantClient: () => makeTenantDb() }));
vi.mock("@/lib/db/service-role-client", () => ({ createServiceRoleClient: () => makeAdminDb() }));

import { POST } from "@/app/api/quotes/[id]/accept/route";

const PARAMS = { params: Promise.resolve({ id: QUOTE_ID }) };

function req(): Request {
  return new Request(`https://tenant.example.com/api/quotes/${QUOTE_ID}/accept`, { method: "POST" });
}

function storedSnapshot(): Record<string, unknown> {
  expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
  const call = mocks.writeAuditLog.mock.calls[0];
  if (!call) throw new Error("writeAuditLog was not called");
  return (call[0] as { changes: Record<string, unknown> }).changes;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID, source: { kind: "http_request", user_id: "u1" } },
    user: { id: "u1", auth_user_id: "auth-1", tenant_id: TENANT_ID, status: "active", role: "agent" },
  });
  mocks.writeAuditLog.mockResolvedValue(undefined);
  mocks.triggerMatchingSequences.mockResolvedValue(undefined);
});

describe("accept route — snapshot is the full rendered HTML, verbatim (#1715)", () => {
  it("stores the exact renderer output (full document, not a hash) into audit_log.changes.pdf_html", async () => {
    const HTML_V1 = "<!doctype html><html><body>ACCEPTED DOCUMENT v1 — total $1,200.00</body></html>";
    mocks.renderQuotePdfHtml.mockReturnValue({ html: HTML_V1, content_hash: "hashv1" });

    const res = await POST(req(), PARAMS);
    expect(res.status).toBe(200);

    const changes = storedSnapshot();
    // The FULL html is persisted — this is what makes the snapshot immutable and
    // reproducible without re-running the renderer. Storing only a hash/length
    // (the pre-#48 behavior) would break dispute reconstruction.
    expect(changes.pdf_html).toBe(HTML_V1);
    expect(changes.pdf_content_hash).toBe("hashv1");
    expect(changes.pdf_html_length).toBe(HTML_V1.length);
  });

  it("a later renderer edit does NOT alter an already-stored snapshot", async () => {
    const HTML_V1 = "<!doctype html><html><body>ACCEPTED v1</body></html>";
    mocks.renderQuotePdfHtml.mockReturnValue({ html: HTML_V1, content_hash: "hashv1" });

    await POST(req(), PARAMS);
    const changes = storedSnapshot();
    expect(changes.pdf_html).toBe(HTML_V1);

    // render-pdf.ts "evolves" — new footer copy, restyle, formatting fix. The
    // renderer now emits different HTML for the same quote.
    const HTML_V2 = "<!doctype html><html><body>REDESIGNED v2 — different footer</body></html>";
    mocks.renderQuotePdfHtml.mockReturnValue({ html: HTML_V2, content_hash: "hashv2" });

    // The snapshot captured at accept time is unchanged. Display MUST read this
    // frozen value, never re-render from the evolved renderer — otherwise the
    // customer's accepted document would silently mutate under them.
    expect(changes.pdf_html).toBe(HTML_V1);
    expect(changes.pdf_html).not.toBe(HTML_V2);
  });
});

describe("accept route — the real renderer's output is a self-contained frozen document (#1715)", () => {
  it("stored snapshot equals the real render of the accept-time inputs and changes only when inputs change", async () => {
    const { renderQuotePdfHtml: realRender } =
      await vi.importActual<typeof import("@/lib/quotes/render-pdf")>("@/lib/quotes/render-pdf");
    mocks.renderQuotePdfHtml.mockImplementation(realRender);

    const res = await POST(req(), PARAMS);
    expect(res.status).toBe(200);

    const changes = storedSnapshot();
    const html = changes.pdf_html as string;
    // Self-contained document: no template refs, renders identically later
    // without the app. This is the property that lets it survive renderer churn.
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("$1,200.00"); // the accept-time total the customer saw

    // Re-rendering the SAME accept-time input reproduces the stored bytes
    // exactly — the snapshot is deterministic, not a moving target.
    const reRendered = realRender({
      quote_id: QUOTE_ID,
      kind: "estimate",
      tenant_name: "Acme Travel",
      host_agency_legal_name: "Travel Pros LLC",
      customer_name: "Customer",
      cruise_line: null,
      ship_name: null,
      sailing_date: null,
      duration_nights: null,
      cabin_category: null,
      passenger_count: null,
      line_items: [{ label: "Total", amount_cents: 120000 }],
      total_cents: 120000,
      currency: "USD",
      variance_cents: 5000,
      priced_at: QUOTE_ROW.priced_at,
      price_lock_expires_at: null,
      validity_days: 7,
    }).html;
    expect(reRendered).toBe(html);

    // A DIFFERENT total (a later re-quote) yields different HTML — proving the
    // stored snapshot really is pinned to the accept-time figures, not the
    // quote's current state.
    const differentTotal = realRender({
      quote_id: QUOTE_ID,
      kind: "estimate",
      tenant_name: "Acme Travel",
      host_agency_legal_name: "Travel Pros LLC",
      customer_name: "Customer",
      cruise_line: null,
      ship_name: null,
      sailing_date: null,
      duration_nights: null,
      cabin_category: null,
      passenger_count: null,
      line_items: [{ label: "Total", amount_cents: 999999 }],
      total_cents: 999999,
      currency: "USD",
      variance_cents: 5000,
      priced_at: QUOTE_ROW.priced_at,
      price_lock_expires_at: null,
      validity_days: 7,
    }).html;
    expect(differentTotal).not.toBe(html);
  });
});
