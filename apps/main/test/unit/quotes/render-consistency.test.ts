// #1596 — the accepted-quote snapshot (renderQuotePdfHtml, an HTML string
// captured verbatim into the audit_log dispute-defense record) and the
// downloadable PDF (renderQuotePdf, a binary via @react-pdf/renderer) used
// to each hand-roll their own formatDate/formatTs/footer-copy. A fix to one
// with the other left unfixed is exactly how the two silently drift —
// this pins that both now render the SAME money + date values from a
// shared QuoteRenderInput fixture, because both import the formatting
// functions from lib/quotes/render-pdf.ts rather than redefining them.

import { describe, it, expect } from "vitest";
import { renderQuotePdfHtml, formatDate, formatTs, type QuoteRenderInput } from "@/lib/quotes/render-pdf";
import { renderQuotePdf } from "@/lib/quotes/render-quote-pdf";
import { extractPdfText } from "@/lib/pdf/extract-pdf-text";
import { formatCents } from "@/lib/money";

const FIXTURE: QuoteRenderInput = {
  quote_id: "q-consistency-1",
  kind: "estimate",
  tenant_name: "Coastal Cruises",
  host_agency_legal_name: "Acme Host Agency LLC",
  customer_name: "Alex Doe",
  cruise_line: "Royal Caribbean",
  ship_name: "Wonder of the Seas",
  sailing_date: "2026-12-01",
  duration_nights: 7,
  cabin_category: "Balcony",
  passenger_count: 2,
  line_items: [{ label: "Cabin", amount_cents: 384712 }],
  total_cents: 384712,
  currency: "USD",
  variance_cents: 5000,
  priced_at: "2026-05-22T10:00:00Z",
  price_lock_expires_at: null,
  validity_days: 7,
};

describe("quote render consistency (#1596)", () => {
  it("HTML snapshot and binary PDF render the same total and variance money strings", async () => {
    const { html } = renderQuotePdfHtml(FIXTURE);
    const pdfBytes = await renderQuotePdf(FIXTURE);
    const pdfText = await extractPdfText(new Uint8Array(pdfBytes));

    const expectedTotal = formatCents(FIXTURE.total_cents, FIXTURE.currency);
    const expectedVariance = formatCents(FIXTURE.variance_cents, FIXTURE.currency);

    expect(html).toContain(expectedTotal);
    expect(pdfText).toContain(expectedTotal);
    expect(html).toContain(expectedVariance);
    expect(pdfText).toContain(expectedVariance);
  });

  it("HTML snapshot and binary PDF render the same validity date string", async () => {
    const { html } = renderQuotePdfHtml(FIXTURE);
    const pdfBytes = await renderQuotePdf(FIXTURE);
    const pdfText = await extractPdfText(new Uint8Array(pdfBytes));

    const expectedDate = formatDate(FIXTURE.priced_at);
    expect(html).toContain(expectedDate);
    expect(pdfText).toContain(expectedDate);
  });

  it("CONFIRMED-kind lock-expiry timestamp matches between renderers", async () => {
    const confirmedFixture: QuoteRenderInput = {
      ...FIXTURE,
      kind: "confirmed",
      price_lock_expires_at: "2026-05-22T11:00:00Z",
    };
    const { html } = renderQuotePdfHtml(confirmedFixture);
    const pdfBytes = await renderQuotePdf(confirmedFixture);
    const pdfText = await extractPdfText(new Uint8Array(pdfBytes));

    const expectedLockEnd = formatTs(confirmedFixture.price_lock_expires_at);
    expect(html).toContain(expectedLockEnd);
    expect(pdfText).toContain(expectedLockEnd);
  });
});
