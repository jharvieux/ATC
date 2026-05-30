// §12.4 / §21.10.1 / §38.5 — Shared loader for QuoteRenderInput.
//
// Centralizes the column projection, tenant + host_agency_legal_name
// lookups, kind selection (estimate vs confirmed), and env defaults so
// the agent-facing PDF download (/api/quotes/[id]/pdf) and the customer
// email attachment (/api/quotes/[id]/send) feed the renderer with the
// exact same input — keeping the bytes equivalent and the disclosure
// language in lockstep with render-pdf.ts's HTML serialization.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TenantContext } from "@/lib/db/tenant-context";
import type { QuoteRenderInput } from "./render-pdf";

const QUOTE_COLUMNS =
  "id, status, customer_access_token, cruise_line, ship_name, sailing_date, " +
  "duration_nights, cabin_category, passenger_count, total_amount, " +
  "locked_price_cents, estimate_price_cents, price_lock_expires_at, priced_at";

export interface QuoteRow {
  id: string;
  status: string;
  customer_access_token: string | null;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  cabin_category: string | null;
  passenger_count: number | null;
  total_amount: number | null;
  locked_price_cents: number | null;
  estimate_price_cents: number | null;
  price_lock_expires_at: string | null;
  priced_at: string | null;
}

export type LoadResult =
  | { ok: true; input: QuoteRenderInput; quote: QuoteRow }
  | { ok: false; status: 404 | 500; message: string };

interface Args {
  ctx: TenantContext;
  db: SupabaseClient;
  adminDb: SupabaseClient;
  quoteId: string;
}

export async function loadQuoteRenderInput(args: Args): Promise<LoadResult> {
  // Tenant-scoped read: the user-JWT client + RLS guarantees this user can
  // only see their tenant's quotes.
  const { data: quoteRow, error: fetchErr } = await args.db
    .from("quotes")
    .select(QUOTE_COLUMNS)
    .eq("id", args.quoteId)
    .maybeSingle();
  if (fetchErr) {
    return { ok: false, status: 500, message: fetchErr.message };
  }
  if (!quoteRow) {
    return { ok: false, status: 404, message: "not_found" };
  }
  const quote = quoteRow as unknown as QuoteRow;

  // Tenant display name. Service-role read (tenants is platform-managed).
  const { data: tenantData, error: tenantErr } = await args.adminDb
    .from("tenants")
    .select("name")
    .eq("id", args.ctx.tenant_id)
    .maybeSingle();
  if (tenantErr) {
    return { ok: false, status: 500, message: `tenant lookup: ${tenantErr.message}` };
  }
  const tenantName = (tenantData as { name?: string } | null)?.name ?? "Sub-host";

  // Host agency legal name — cross-tenant platform_settings; service-role.
  const { data: hostNameRow, error: hostErr } = await args.adminDb
    .from("platform_settings")
    .select("value")
    .eq("key", "host_agency_legal_name")
    .maybeSingle();
  if (hostErr) {
    return { ok: false, status: 500, message: `host lookup: ${hostErr.message}` };
  }
  const hostNameValue = hostNameRow as { value?: unknown } | null;
  const hostName =
    typeof hostNameValue?.value === "string"
      ? hostNameValue.value
      : typeof hostNameValue?.value === "object" && hostNameValue?.value !== null
        ? String((hostNameValue.value as { value?: string }).value ?? "Host Agency")
        : "Host Agency";

  const now = new Date().toISOString();
  const totalCents =
    quote.locked_price_cents ??
    quote.estimate_price_cents ??
    Math.round((quote.total_amount ?? 0) * 100);
  const kind: "confirmed" | "estimate" =
    quote.locked_price_cents != null ? "confirmed" : "estimate";

  const input: QuoteRenderInput = {
    quote_id: quote.id,
    kind,
    tenant_name: tenantName,
    host_agency_legal_name: hostName,
    // Customer display name is hardcoded here, matching the prior /send
    // behavior. The quotes table doesn't carry a denormalized contact
    // display field today; a contact-lookup pass is a follow-up that
    // would touch both this route and /send identically.
    customer_name: "Customer",
    cruise_line: quote.cruise_line,
    ship_name: quote.ship_name,
    sailing_date: quote.sailing_date,
    duration_nights: quote.duration_nights,
    cabin_category: quote.cabin_category,
    passenger_count: quote.passenger_count,
    line_items: [{ label: "Total", amount_cents: totalCents }],
    total_cents: totalCents,
    currency: "USD",
    variance_cents: Number(process.env.QUOTE_DEFAULT_VARIANCE_CENTS ?? 5000),
    priced_at: quote.priced_at ?? now,
    price_lock_expires_at: quote.price_lock_expires_at,
    validity_days: Number(process.env.QUOTE_ESTIMATE_VALIDITY_DAYS ?? 7),
  };

  return { ok: true, input, quote };
}
