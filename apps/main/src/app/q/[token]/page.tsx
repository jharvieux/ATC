// §38.4 / §38.8.1 — Customer-facing quote view by tokenized URL.
//
// Server component. Resolves the token via quotes.customer_access_token
// (status must be sent / viewed / accepted — never draft). Renders a
// tenant-branded quote summary + the options the customer can pick + the
// public-token AI assistant for follow-up questions.

import { notFound } from "next/navigation";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { headers } from "next/headers";
import { writeAuditLog } from "@/lib/audit/write";
import { PublicTokenChatPanel } from "@/components/chat/PublicTokenChatPanel";
import { fromCents, type Cents } from "@/lib/money";
import { selectRepresentativeOption } from "@/lib/quotes/representative-option";

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
  return `${currency ?? "USD"} ${fromCents(cents as Cents)}`;
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
    <main
      style={{
        maxWidth: 760,
        margin: "0 auto",
        padding: "32px 24px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <header
        style={{
          borderBottom: "2px solid #1f4e79",
          paddingBottom: 16,
          marginBottom: 24,
        }}
      >
        <div style={{ color: "#1f4e79", fontWeight: 600, fontSize: 14 }}>
          {tenant?.display_name ?? ""}
        </div>
        <h1 style={{ margin: "8px 0 4px", fontSize: 28 }}>{headerTitle}</h1>
        <div style={{ color: "#555", fontSize: 14 }}>
          {rep?.sailing_date ?? "Sailing TBD"}
          {rep?.duration_nights ? ` · ${rep.duration_nights} nights` : ""}
          {rep?.cabin_category ? ` · ${rep.cabin_category}` : ""}
        </div>
        {quote.valid_until && (
          <div style={{ marginTop: 6, fontSize: 12, color: "#92400e" }}>
            Hold expires {new Date(quote.valid_until).toLocaleDateString()}
          </div>
        )}
      </header>

      {quote.customer_facing_intro && (
        <section style={{ marginBottom: 24 }}>
          <p style={{ margin: 0, color: "#374151", lineHeight: 1.5 }}>
            {quote.customer_facing_intro}
          </p>
        </section>
      )}

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ color: "#1f4e79", fontSize: 18, marginBottom: 12 }}>Price</h2>
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "180px 1fr",
            rowGap: 6,
            fontSize: 14,
          }}
        >
          <dt style={{ color: "#6b7280" }}>Total</dt>
          {/* §38.4.3 price priority: locked > estimate > representative option total */}
          <dd style={{ margin: 0, fontWeight: 600 }}>
            {money(quote.locked_price_cents ?? quote.estimate_price_cents ?? rep?.total_amount_cents ?? null, currency)}
          </dd>
          {quote.show_breakdown_to_customer && (
            <>
              <dt style={{ color: "#6b7280" }}>Cruise fare</dt>
              <dd style={{ margin: 0 }}>
                {money(rep?.commissionable_fare_cents ?? null, currency)}
              </dd>
              <dt style={{ color: "#6b7280" }}>Other charges</dt>
              <dd style={{ margin: 0 }}>
                {money(rep?.non_commissionable_total_cents ?? null, currency)}
              </dd>
            </>
          )}
          <dt style={{ color: "#6b7280" }}>Passengers</dt>
          <dd style={{ margin: 0 }}>{rep?.passenger_count ?? "—"}</dd>
        </dl>
      </section>

      {options.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ color: "#1f4e79", fontSize: 18, marginBottom: 12 }}>Options</h2>
          <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {options.map((o) => (
              <li
                key={o.id}
                style={{
                  border: o.customer_selected ? "2px solid #1f4e79" : "1px solid #e5e7eb",
                  borderRadius: 8,
                  padding: 14,
                  marginBottom: 10,
                  background: o.customer_selected ? "#eff6ff" : "#fff",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {o.cruise_line ?? "—"} {o.ship_name ?? ""}{" "}
                      {o.is_recommended && (
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 600,
                            color: "#1f4e79",
                            background: "#dbeafe",
                            padding: "2px 6px",
                            borderRadius: 4,
                            marginLeft: 6,
                          }}
                        >
                          Recommended
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 13, color: "#555" }}>
                      {o.sailing_date ?? "—"}
                      {o.duration_nights ? ` · ${o.duration_nights} nights` : ""}
                      {o.cabin_category ? ` · ${o.cabin_category}` : ""}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontWeight: 600 }}>{money(o.total_amount_cents, o.currency)}</div>
                    {o.customer_selected && (
                      <div style={{ fontSize: 11, color: "#1f4e79", marginTop: 2 }}>Selected</div>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <p style={{ fontSize: 12, color: "#6b7280", marginTop: 8 }}>
            To change your selection, contact your agent.
          </p>
        </section>
      )}

      {quote.show_recommendation && quote.recommendation_rationale && (
        <section
          style={{
            marginBottom: 24,
            background: "#f0f9ff",
            border: "1px solid #bae6fd",
            borderRadius: 8,
            padding: 14,
          }}
        >
          <h3 style={{ margin: "0 0 6px", fontSize: 14, color: "#0369a1" }}>
            Why we recommend this
          </h3>
          <p style={{ margin: 0, fontSize: 14, color: "#0c4a6e", lineHeight: 1.5 }}>
            {quote.recommendation_rationale}
          </p>
        </section>
      )}

      {quote.custom_notes && (
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ color: "#1f4e79", fontSize: 18, marginBottom: 8 }}>Notes from your agent</h2>
          <p style={{ margin: 0, color: "#374151", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
            {quote.custom_notes}
          </p>
        </section>
      )}

      <section style={{ marginTop: 32 }}>
        <PublicTokenChatPanel token={token} surface="quote" />
      </section>

      <footer
        style={{
          marginTop: 40,
          borderTop: "1px solid #e5e7eb",
          paddingTop: 16,
          color: "#888",
          fontSize: 12,
        }}
      >
        Questions? Ask the assistant above or reply to the email your agent sent.
      </footer>
    </main>
  );
}
