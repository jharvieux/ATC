// §12.4 / §21.10.1 — Single source of truth for a quote's rendered
// `kind` + `variance_cents`.
//
// #1699: two paths build the shared QuoteRenderInput and MUST agree —
//   1. the downloadable-PDF route (buildRenderInputFromQuote), and
//   2. the accept-time snapshot (api/quotes/[id]/accept), whose stored
//      pdf_html is the dispute-defense record.
// Before this helper existed they derived kind/variance independently:
// the PDF path used a `locked_price_cents != null` heuristic + the raw env
// variance default, while accept used the persisted `price_kind` column +
// tenant_settings.quote_variance_cents. A tenant with a customized variance,
// or a lock that had expired, saw one value on the downloadable PDF and a
// different one on the accepted snapshot. Both now call this.
//
// Authoritative inputs (accept route's values win):
//   - kind comes from the persisted `quotes.price_kind` column (DB default
//     'estimate'), NOT a locked_price_cents check — the column can legitimately
//     say 'estimate' for a quote whose lock has expired.
//   - variance is the tenant-configured `tenant_settings.quote_variance_cents`
//     (env default when the tenant hasn't customized it), forced to 0 for a
//     confirmed quote because a locked price allows no variance.

import type { QuoteKind } from "./kind-resolver";

export type { QuoteKind };

export interface KindVarianceInput {
  price_kind: QuoteKind | null;
  tenant_variance_cents: number | null | undefined;
}

export function deriveKindAndVariance(
  input: KindVarianceInput,
): { kind: QuoteKind; variance_cents: number } {
  const kind: QuoteKind = input.price_kind ?? "estimate";
  const variance_cents =
    kind === "confirmed"
      ? 0
      : input.tenant_variance_cents ?? Number(process.env.QUOTE_DEFAULT_VARIANCE_CENTS ?? 5000);
  return { kind, variance_cents };
}
