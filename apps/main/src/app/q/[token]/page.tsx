// §38.4 / §38.8.1 — Customer-facing quote view by tokenized URL.
//
// Server component. Resolves the token via quotes.customer_access_token
// (status must be sent / viewed / accepted — never draft). Renders a
// tenant-branded quote summary + the options the customer can pick + the
// public-token AI assistant for follow-up questions.

import { notFound } from "next/navigation";
import { formatDate } from "@/lib/format-date";
import type { Metadata } from "next";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { headers } from "next/headers";
import { writeAuditLog } from "@/lib/audit/write";
import { PublicTokenChatPanel } from "@/components/chat/PublicTokenChatPanel";
import { TenantTheme } from "@/components/branding/TenantTheme";
import { getRequestTenantBranding } from "@/lib/branding/request-branding";
import { fromCents } from "@/lib/money";
import { selectRepresentativeOption } from "@/lib/quotes/representative-option";

// §16.2 — tenant subdomains show the tenant's name + favicon on the quote page.
export async function generateMetadata(): Promise<Metadata> {
  const branding = await getRequestTenantBranding();
  if (!branding) return {};
  return {
    title: branding.display_name,
    ...(branding.favicon_url ? { icons: { icon: branding.favicon_url } } : {}),
  };
}

interface PageProps {
  params: Promise<{ token: string }>;
}

type QuoteRow = {
  id: string;
  tenant_id: string;
  status: string;
  locked_price_cents: number | bigint | null;
  estimate_price_cents: number | bigint | null;
  custom_notes: string | null;
  customer_facing_intro: string | null;
  recommendation_rationale: string | null;
  show_recommendation: boolean | null;
  show_breakdown_to_customer: boolean | null;
  valid_until: string | null;
  tenants:
    | { display_name: string | null }
    | { display_name: string | null }[]
    | null;
};

type QuoteOptionRow = {
  id: string;
  option_index: number;
  customer_selected: boolean | null;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  cabin_category: string | null;
  passenger_count: number | null;
  commissionable_fare_cents: number | bigint | null;
  non_commissionable_total_cents: number | bigint | null;
  total_amount_cents: number | bigint | null;
  currency: string | null;
  is_recommended: boolean | null;
};

function money(amount: number | bigint | null | undefined, currency: string | null): string {
  if (amount === null || amount === undefined) return "—";
  const cents = typeof amount === "bigint" ? amount : BigInt(amount);
  return `${currency ?? "USD"} ${fromCents(cents)}`;
}

export default async function CustomerQuoteViewPage(props: PageProps): Promise<JSX.Element> {
  const { token } = await props.params;
  const svc = createServiceRoleClient();

  const { data, error } = await svc
    .from("quotes")
    .select(
      "id, tenant_id, status, locked_price_cents, estimate_price_cents, custom_notes, customer_facing_intro, recommendation_rationale, show_recommendation, show_breakdown_to_customer, valid_until, tenants(display_name)",
    )
    .eq("customer_access_token", token)
    .maybeSingle();
  if (error || !data) notFound();
  const quote = data as QuoteRow;

  // §38.4 — draft quotes must never be visible via the customer link.
  if (quote.status === "draft") notFound();

  // Bump status sent → viewed on first view. CAS guard (status='sent')
  // makes the write idempotent across concurrent first-views; we accept
  // either outcome (updated or already-bumped) and warn-log unexpected
  // errors. Not safeAwait — first-view is best-effort.
  if (quote.status === "sent") {
    const { error: viewErr } = await svc
      .from("quotes")
      .update({ status: "viewed", viewed_at: new Date().toISOString() })
      .eq("id", quote.id)
      .eq("status", "sent");
    if (viewErr) {
      console.warn(`[quote-view] sent→viewed transition failed: ${viewErr.message}`);
    }
  }

  const { data: optionsData } = await svc
    .from("quote_options")
    .select(
      "id, option_index, customer_selected, cruise_line, ship_name, sailing_date, duration_nights, cabin_category, passenger_count, commissionable_fare_cents, non_commissionable_total_cents, total_amount_cents, currency, is_recommended",
    )
    .eq("quote_id", quote.id)
    .eq("tenant_id", quote.tenant_id)
    .order("option_index", { ascending: true });
  const options = (optionsData ?? []) as QuoteOptionRow[];

  // §38.4.3 — trip detail + per-option financials live on quote_options; the
  // quote is a container. Header + price summary render the representative
  // option (customer-selected, else lowest option_index).
  const rep = selectRepresentativeOption(options);
  const currency = rep?.currency ?? null;

  const tenant = Array.isArray(quote.tenants) ? quote.tenants[0] : quote.tenants;

  // Audit who viewed — same pattern as /i/[token].
  const h = await headers();
  await writeAuditLog({
    tenant_id: quote.tenant_id,
    actor_type: "system",
    action: "quote.viewed",
    resource_type: "quote",
    resource_id: quote.id,
    context: {
      ip: h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? null,
      user_agent: h.get("user-agent") ?? null,
    },
  });

  const headerTitle = rep?.cruise_line && rep?.ship_name
    ? `${rep.cruise_line} — ${rep.ship_name}`
    : rep?.cruise_line ?? rep?.ship_name ?? "Your cruise quote";

  return (
    <main className="max-w-[760px] mx-auto px-6 py-8">
      {/* §16.2 — tenant colors/font when viewed on the tenant subdomain. */}
      <TenantTheme />
      <header className="border-b-2 border-[#1f4e79] pb-4 mb-6">
        <div className="text-[#1f4e79] font-semibold text-[14px]">
          {tenant?.display_name ?? ""}
        </div>
        <h1 className="mt-2 mb-1 text-[28px]">{headerTitle}</h1>
        <div className="text-muted-foreground text-[14px]">
          {rep?.sailing_date ?? "Sailing TBD"}
          {rep?.duration_nights ? ` · ${rep.duration_nights} nights` : ""}
          {rep?.cabin_category ? ` · ${rep.cabin_category}` : ""}
        </div>
        {quote.valid_until && (
          <div className="mt-1.5 text-[12px] text-amber-800 dark:text-amber-400">
            Hold expires {formatDate(quote.valid_until)}
          </div>
        )}
      </header>

      {quote.customer_facing_intro && (
        <section className="mb-6">
          <p className="m-0 text-foreground leading-[1.5]">
            {quote.customer_facing_intro}
          </p>
        </section>
      )}

      <section className="mb-6">
        <h2 className="text-[#1f4e79] text-[18px] mb-3">Price</h2>
        <dl className="grid grid-cols-[180px_1fr] gap-y-1.5 text-[14px]">
          <dt className="text-muted-foreground">Total</dt>
          {/* §38.4.3 price priority: locked > estimate > representative option total */}
          <dd className="m-0 font-semibold">
            {money(quote.locked_price_cents ?? quote.estimate_price_cents ?? rep?.total_amount_cents ?? null, currency)}
          </dd>
          {quote.show_breakdown_to_customer && (
            <>
              <dt className="text-muted-foreground">Cruise fare</dt>
              <dd className="m-0">
                {money(rep?.commissionable_fare_cents ?? null, currency)}
              </dd>
              <dt className="text-muted-foreground">Other charges</dt>
              <dd className="m-0">
                {money(rep?.non_commissionable_total_cents ?? null, currency)}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">Passengers</dt>
          <dd className="m-0">{rep?.passenger_count ?? "—"}</dd>
        </dl>
      </section>

      {options.length > 0 && (
        <section className="mb-6">
          <h2 className="text-[#1f4e79] text-[18px] mb-3">Options</h2>
          <ul className="m-0 p-0 list-none">
            {options.map((o) => (
              <li
                key={o.id}
                className={`rounded-lg p-[14px] mb-2.5 ${
                  o.customer_selected
                    ? "border-2 border-[#1f4e79] bg-blue-50 dark:bg-blue-950/20"
                    : "border border-border bg-card"
                }`}
              >
                <div className="flex justify-between items-baseline gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold">
                      {o.cruise_line ?? "—"} {o.ship_name ?? ""}{" "}
                      {o.is_recommended && (
                        <span className="text-[11px] font-semibold text-[#1f4e79] bg-blue-100 dark:bg-blue-900/40 dark:text-blue-300 px-1.5 py-0.5 rounded ml-1.5">
                          Recommended
                        </span>
                      )}
                    </div>
                    <div className="text-[13px] text-muted-foreground">
                      {o.sailing_date ?? "—"}
                      {o.duration_nights ? ` · ${o.duration_nights} nights` : ""}
                      {o.cabin_category ? ` · ${o.cabin_category}` : ""}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="font-semibold">{money(o.total_amount_cents, o.currency)}</div>
                    {o.customer_selected && (
                      <div className="text-[11px] text-[#1f4e79] mt-0.5">Selected</div>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-[12px] text-muted-foreground mt-2">
            To change your selection, contact your agent.
          </p>
        </section>
      )}

      {quote.show_recommendation && quote.recommendation_rationale && (
        <section className="mb-6 bg-sky-50 dark:bg-sky-950/20 border border-sky-200 dark:border-sky-800 rounded-lg p-[14px]">
          <h3 className="m-0 mb-1.5 text-[14px] text-sky-700 dark:text-sky-400">
            Why we recommend this
          </h3>
          <p className="m-0 text-[14px] text-sky-900 dark:text-sky-200 leading-[1.5]">
            {quote.recommendation_rationale}
          </p>
        </section>
      )}

      {quote.custom_notes && (
        <section className="mb-6">
          <h2 className="text-[#1f4e79] text-[18px] mb-2">Notes from your agent</h2>
          <p className="m-0 text-foreground leading-[1.5] whitespace-pre-wrap">
            {quote.custom_notes}
          </p>
        </section>
      )}

      <section className="mt-8">
        <PublicTokenChatPanel token={token} surface="quote" />
      </section>

      <footer className="mt-10 border-t border-border pt-4 text-muted-foreground text-[12px]">
        Questions? Ask the assistant above or reply to the email your agent sent.
      </footer>
    </main>
  );
}
