// §21.10.1 — Quote PDF: shared formatting source + audit-snapshot HTML.
//
// This file is the single source of truth for the §21.10.1 disclosure copy
// (ESTIMATE / CONFIRMED footer templates) and the date/money formatters, and
// it renders the deterministic HTML serialization that is captured verbatim
// into the audit_log snapshot — the document that wins arbitrations.
//
// The customer-facing binary PDF is produced by render-quote-pdf.tsx (via
// @react-pdf/renderer), which imports the footer templates and formatters
// from HERE so the two renderers can't drift on legally-significant text.
// The renderer choice is documented in MEMORY (D-053).

import { escapeHtml } from "@/lib/utils";
import { formatCents } from "@/lib/money";

export interface QuoteLineItem {
  label: string;
  amount_cents: number;
}

export interface QuoteRenderInput {
  quote_id: string;
  kind: "estimate" | "confirmed";
  tenant_name: string;
  host_agency_legal_name: string;
  customer_name: string;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  cabin_category: string | null;
  passenger_count: number | null;
  line_items: QuoteLineItem[];
  total_cents: number;
  currency: string;
  variance_cents: number; // tenant_settings.quote_variance_cents
  priced_at: string;
  price_lock_expires_at: string | null;
  validity_days: number;
}

export interface QuoteRenderResult {
  // HTML serialization — the renderer-agnostic representation. Captured into
  // the audit_log snapshot per §21.10.1 "Audit".
  html: string;
  // Hash of the html — convenience handle for audit-row dedup.
  content_hash: string;
}

// #1596: exported so render-quote-pdf.tsx (the binary renderer) consumes
// the SAME footer copy instead of a hand-maintained duplicate — the two
// renderers drifting on legally-significant disclosure text is exactly
// the bug this fixes.
// Single-line (spaces, no hard newlines) so each renderer wraps the text to
// its own column width — react-pdf treats an embedded \n as a forced line
// break, which would deform the customer-facing PDF. The words are the source
// of truth; the line breaks are the renderer's business.
export const ESTIMATE_FOOTER_TEMPLATE = (varianceUsd: string): string =>
  `This is an ESTIMATE — the final price at booking may differ. By accepting, you authorize us to submit the booking at the actual price PROVIDED the price is within ${varianceUsd} of the estimate above. If the actual price falls OUTSIDE this variance, we will pause the booking and ask you to reconfirm at the new price before submitting. Estimate quotes are valid for the period shown; after that they automatically expire and a fresh quote is required.`;

export const CONFIRMED_FOOTER_TEMPLATE = (host: string, lockEnd: string): string =>
  `This is a CONFIRMED quote. ${host} has price-locked this fare through ${lockEnd}. Acceptance submits the booking at the locked price.`;

export function renderQuotePdfHtml(input: QuoteRenderInput): QuoteRenderResult {
  const isEstimate = input.kind === "estimate";
  const variance = formatCents(input.variance_cents, input.currency);

  const headerBanner = isEstimate
    ? `ESTIMATE — pricing subject to confirmation at booking`
    : `QUOTE — price locked through ${formatTs(input.price_lock_expires_at)}`;

  const validityCopy = isEstimate
    ? `Valid for ${input.validity_days} days from ${formatDate(input.priced_at)}.`
    : `Valid through ${formatTs(input.price_lock_expires_at)}.`;

  const footer = isEstimate
    ? ESTIMATE_FOOTER_TEMPLATE(variance)
    : CONFIRMED_FOOTER_TEMPLATE(input.host_agency_legal_name, formatTs(input.price_lock_expires_at));

  const itemRows = input.line_items
    .map((li) => {
      const amount = formatCents(li.amount_cents, input.currency);
      const marker = isEstimate ? " <em>est.</em>" : "";
      return `<tr><td>${escapeHtml(li.label)}</td><td class="right">${amount}${marker}</td></tr>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Quote ${escapeHtml(input.quote_id)}</title>
<style>
  body{font:14px/1.5 -apple-system,Helvetica,Arial,sans-serif;color:#1f2937;padding:32px;}
  .banner{padding:12px 16px;border-radius:6px;font-weight:600;margin-bottom:16px;}
  .estimate{background:#fef3c7;color:#92400e;}
  .confirmed{background:#d1fae5;color:#065f46;}
  table{width:100%;border-collapse:collapse;margin:16px 0;}
  td{padding:8px 4px;border-bottom:1px solid #e5e7eb;}
  td.right{text-align:right;}
  tfoot td{font-weight:600;border-top:2px solid #111827;border-bottom:none;}
  .footer{margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#4b5563;white-space:pre-wrap;}
  .disclosure{margin-top:16px;padding:12px;background:#fff7ed;border-radius:6px;font-size:12px;}
  em{font-style:italic;color:#92400e;}
</style></head><body>
<div class="banner ${isEstimate ? "estimate" : "confirmed"}">${escapeHtml(headerBanner)}</div>
<h1>${escapeHtml(input.tenant_name)}</h1>
<p>Prepared for <strong>${escapeHtml(input.customer_name)}</strong> · Quote <code>${escapeHtml(input.quote_id)}</code></p>
<p>${escapeHtml(input.cruise_line ?? "Cruise")} — ${escapeHtml(input.ship_name ?? "")} · ${escapeHtml(input.sailing_date ?? "")} · ${input.duration_nights ?? "?"} nights · ${escapeHtml(input.cabin_category ?? "")} · ${input.passenger_count ?? "?"} pax</p>
<table>
<tbody>
${itemRows}
</tbody>
<tfoot>
<tr><td>Total</td><td class="right">${formatCents(input.total_cents, input.currency)}${isEstimate ? " <em>est.</em>" : ""}</td></tr>
</tfoot>
</table>
<p>${escapeHtml(validityCopy)}</p>
<div class="disclosure">This booking will be made through <strong>${escapeHtml(input.host_agency_legal_name)}</strong>. Your sub-host: <strong>${escapeHtml(input.tenant_name)}</strong>.</div>
<div class="footer">${escapeHtml(footer)}</div>
</body></html>`;

  return {
    html,
    content_hash: hashString(html),
  };
}

// #1596: exported — the single source for both renderers (see
// render-quote-pdf.tsx), so the HTML snapshot and the binary PDF can't
// format the same timestamp two different ways.
export function formatDate(ts: string): string {
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return ts;
  }
}

export function formatTs(ts: string | null): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  } catch {
    return ts;
  }
}

function hashString(s: string): string {
  // FNV-1a 32-bit — adequate for dedup, not security.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
