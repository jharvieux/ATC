// §21.10.1 — Quote PDF render tests.
// Why these matter: the rendered HTML IS the audit snapshot until the binary
// renderer is wired. The banner copy and footer wording carry legal weight
// (estimate-variance disclosure, host disclosure).

import { describe, it, expect } from "vitest";
import { renderQuotePdfHtml } from "@/lib/quotes/render-pdf";

const baseInput = {
  quote_id: "q-123",
  tenant_name: "Coastal Cruises",
  host_agency_legal_name: "Acme Host Agency LLC",
  customer_name: "Alex Doe",
  cruise_line: "Royal Caribbean",
  ship_name: "Wonder of the Seas",
  sailing_date: "2026-12-01",
  duration_nights: 7,
  cabin_category: "Balcony",
  passenger_count: 2,
  line_items: [{ label: "Cabin", amount_cents: 384700 }],
  total_cents: 384700,
  currency: "USD",
  variance_cents: 5000,
  priced_at: "2026-05-22T10:00:00Z",
  validity_days: 7,
};

describe("renderQuotePdfHtml — §21.10.1", () => {
  it("renders ESTIMATE banner + 'est.' inline marker + variance footer", () => {
    const out = renderQuotePdfHtml({ ...baseInput, kind: "estimate", price_lock_expires_at: null });
    expect(out.html).toContain("ESTIMATE — pricing subject to confirmation");
    expect(out.html).toContain("est.");
    expect(out.html).toContain("$50.00"); // variance interpolation
    expect(out.html).toContain("Acme Host Agency LLC");
    expect(out.html).toContain("Coastal Cruises");
    expect(out.content_hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("renders CONFIRMED banner with lock expiry and host name footer", () => {
    const out = renderQuotePdfHtml({
      ...baseInput,
      kind: "confirmed",
      price_lock_expires_at: "2026-05-22T11:00:00Z",
    });
    expect(out.html).toContain("QUOTE — price locked through");
    expect(out.html).toContain("Acme Host Agency LLC");
    expect(out.html).not.toContain("ESTIMATE — pricing subject to");
    expect(out.html).not.toMatch(/est\.</);
  });

  it("escapes HTML in user-controlled strings", () => {
    const out = renderQuotePdfHtml({
      ...baseInput,
      kind: "estimate",
      price_lock_expires_at: null,
      tenant_name: "<script>alert(1)</script>",
    });
    expect(out.html).not.toContain("<script>alert(1)</script>");
    expect(out.html).toContain("&lt;script&gt;");
  });
});
