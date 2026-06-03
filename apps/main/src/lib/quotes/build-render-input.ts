// §12.4 / §21.10.1 / §38.5 — Shared QuoteRow loader + render-input builder.
//
// Why split: /send needs to short-circuit non-draft sends with a 409 BEFORE
// running the tenant + host lookups (otherwise a non-draft send pays two
// extra round-trips to return the same error). /pdf needs the full input
// regardless of status. So the loader stays cheap (one quotes SELECT) and
// the enrich pass (which fetches tenant + platform_settings + the
// representative quote_options row) is a second call that both routes make
// when they actually need to render.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TenantContext } from "@/lib/db/tenant-context";
import type { QuoteRenderInput } from "./render-pdf";
import { selectRepresentativeOption } from "./representative-option";

// §38 — the quotes row is a container now; trip detail + per-option
// financials live on quote_options. The loader pulls only container/pricing
// fields; buildRenderInputFromQuote reads the representative option for trip
// detail.
const QUOTE_COLUMNS =
  "id, status, customer_access_token, " +
  "locked_price_cents, estimate_price_cents, price_lock_expires_at, priced_at";

export interface QuoteRow {
  id: string;
  status: string;
  customer_access_token: string | null;
  locked_price_cents: number | null;
  estimate_price_cents: number | null;
  price_lock_expires_at: string | null;
  priced_at: string | null;
}

// The slice of a quote_options row the renderer needs. customer_selected +
// option_index drive representative selection (§38.4.3); the rest is the trip
// summary + the per-option total used as the price fallback.
interface RenderOptionRow {
  option_index: number;
  customer_selected: boolean | null;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  cabin_category: string | null;
  passenger_count: number | null;
  total_amount_cents: number | null;
}

export type LoadQuoteResult =
  | { ok: true; quote: QuoteRow }
  | { ok: false; status: 404 | 500; message: string };

export type BuildInputResult =
  | { ok: true; input: QuoteRenderInput }
  | { ok: false; status: 500; message: string };

interface LoadArgs {
  db: SupabaseClient;
  quoteId: string;
}

interface BuildArgs {
  ctx: TenantContext;
  adminDb: SupabaseClient;
  quote: QuoteRow;
}

// One tenant-scoped SELECT; cheap. Routes call this first so they can
// branch on quote.status (or 404) before paying the enrich cost.
export async function loadQuoteRow(args: LoadArgs): Promise<LoadQuoteResult> {
  const { data: row, error } = await args.db
    .from("quotes")
    .select(QUOTE_COLUMNS)
    .eq("id", args.quoteId)
    .maybeSingle();
  if (error) {
    return { ok: false, status: 500, message: error.message };
  }
  if (!row) {
    return { ok: false, status: 404, message: "not_found" };
  }
  return { ok: true, quote: row as unknown as QuoteRow };
}

// Enriches with tenant + host name and produces the render input. Two
// service-role lookups (tenants by id, platform_settings by key). Fails
// loud on either lookup error — the renderer shouldn't run with default
// "Sub-host" / "Host Agency" strings on the customer-visible PDF.
export async function buildRenderInputFromQuote(
  args: BuildArgs,
): Promise<BuildInputResult> {
  const { data: tenantData, error: tenantErr } = await args.adminDb
    .from("tenants")
    .select("name")
    .eq("id", args.ctx.tenant_id)
    .maybeSingle();
  if (tenantErr) {
    return { ok: false, status: 500, message: `tenant lookup: ${tenantErr.message}` };
  }
  const tenantName = (tenantData as { name?: string } | null)?.name ?? "Sub-host";

  // platform_settings.value historically ships as either a bare string or
  // a JSON object with .value — both forms are in the wild on dev, so the
  // helper tolerates both rather than picking one and breaking the other.
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

  // §38 — trip detail lives on quote_options. Read this quote's options and
  // pick the representative one (customer-selected, else lowest option_index).
  // adminDb is service-role (RLS bypassed), so scope the read by BOTH
  // tenant_id and quote_id — D-091 two-layer isolation on a service-role read.
  const { data: optionRows, error: optionsErr } = await args.adminDb
    .from("quote_options")
    .select(
      "option_index, customer_selected, cruise_line, ship_name, sailing_date, duration_nights, cabin_category, passenger_count, total_amount_cents",
    )
    .eq("tenant_id", args.ctx.tenant_id)
    .eq("quote_id", args.quote.id)
    .order("option_index", { ascending: true });
  if (optionsErr) {
    return { ok: false, status: 500, message: `options lookup: ${optionsErr.message}` };
  }
  const option = selectRepresentativeOption(
    (optionRows ?? []) as RenderOptionRow[],
  );

  const now = new Date().toISOString();
  const totalCents =
    args.quote.locked_price_cents ??
    args.quote.estimate_price_cents ??
    option?.total_amount_cents ??
    0;
  const kind: "confirmed" | "estimate" =
    args.quote.locked_price_cents != null ? "confirmed" : "estimate";

  const input: QuoteRenderInput = {
    quote_id: args.quote.id,
    kind,
    tenant_name: tenantName,
    host_agency_legal_name: hostName,
    // No denormalized contact field on `quotes` today; contact-lookup is
    // a follow-up that would touch /send and /pdf identically.
    customer_name: "Customer",
    cruise_line: option?.cruise_line ?? null,
    ship_name: option?.ship_name ?? null,
    sailing_date: option?.sailing_date ?? null,
    duration_nights: option?.duration_nights ?? null,
    cabin_category: option?.cabin_category ?? null,
    passenger_count: option?.passenger_count ?? null,
    line_items: [{ label: "Total", amount_cents: totalCents }],
    total_cents: totalCents,
    currency: "USD",
    variance_cents: Number(process.env.QUOTE_DEFAULT_VARIANCE_CENTS ?? 5000),
    priced_at: args.quote.priced_at ?? now,
    price_lock_expires_at: args.quote.price_lock_expires_at,
    validity_days: Number(process.env.QUOTE_ESTIMATE_VALIDITY_DAYS ?? 7),
  };

  return { ok: true, input };
}
