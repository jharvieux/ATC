// §12.4 / §21.10.1 — Accept a quote.
//
// Behavior:
//   1. ESTIMATE quotes: record `customer_accepted_variance_cents`
//      (= tenant_settings.quote_variance_cents, falls back to env default),
//      record `customer_accepted_at = NOW()`, and write an audit_log snapshot
//      that captures the rendered PDF HTML, the prices the customer saw, the
//      variance threshold, and the customer's identity. The audit row's id
//      lands in `customer_accepted_audit_id` — this is the dispute defense.
//   2. CONFIRMED quotes: same audit snapshot but with the lock token + expiry
//      recorded. The customer-accepted variance is zero (no variance allowed
//      on a locked price).
//
// All audit_log writes are stubbed to console.warn (D-036) — the table does
// not yet exist. The customer_accepted_audit_id column is still populated
// with a fresh UUID so the snapshot can be linked when audit_log lands.

import { randomUUID } from "node:crypto";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { renderQuotePdfHtml } from "@/lib/quotes/render-pdf";
import { writeAuditLog } from "@/lib/audit/write";
import { respondToAuthError } from "@/lib/auth/respond";

interface QuoteRow {
  id: string;
  tenant_id: string;
  status: string;
  price_kind: "estimate" | "confirmed" | null;
  priced_at: string | null;
  price_lock_token: string | null;
  price_lock_expires_at: string | null;
  estimate_price_cents: number | null;
  locked_price_cents: number | null;
  total_amount: number | null;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  cabin_category: string | null;
  passenger_count: number | null;
  contact_id: string | null;
  user_id: string | null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "quotes", action: "accept" });
    const db = tenantClient(ctx);
    const adminDb = createServiceRoleClient();
    const { id } = await params;

    const { data: existing, error: fetchErr } = await db
      .from("quotes")
      .select(
        "id, tenant_id, status, price_kind, priced_at, price_lock_token, price_lock_expires_at, estimate_price_cents, locked_price_cents, total_amount, cruise_line, ship_name, sailing_date, duration_nights, cabin_category, passenger_count, contact_id, user_id",
      )
      .eq("id", id)
      .maybeSingle();

    if (fetchErr) return Response.json({ error: fetchErr.message }, { status: 500 });
    if (!existing) return Response.json({ error: "not_found" }, { status: 404 });

    const quote = existing as QuoteRow;
    if (!["sent", "viewed"].includes(quote.status)) {
      return Response.json({ error: "quote_not_in_sent_or_viewed_status" }, { status: 409 });
    }

    const kind = quote.price_kind ?? "estimate";

    // Variance threshold from tenant_settings (or env default for tenants
    // that haven't customized it).
    const { data: settingsData } = await db
      .from("tenant_settings")
      .select("quote_variance_cents")
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    const settingsVariance = (settingsData as { quote_variance_cents?: number } | null)?.quote_variance_cents;
    const varianceCents = kind === "confirmed"
      ? 0
      : (settingsVariance ?? Number(process.env.QUOTE_DEFAULT_VARIANCE_CENTS ?? 5000));

    // Tenant + host agency display info for the PDF render.
    const { data: tenantData } = await adminDb
      .from("tenants")
      .select("name, support_email")
      .eq("id", ctx.tenant_id)
      .maybeSingle();
    const tenantName = (tenantData as { name?: string } | null)?.name ?? "Sub-host";

    const { data: hostNameRow } = await adminDb
      .from("platform_settings")
      .select("value")
      .eq("key", "host_agency_legal_name")
      .maybeSingle();
    const hostName = typeof hostNameRow?.value === "string"
      ? hostNameRow.value
      : (typeof hostNameRow?.value === "object" && hostNameRow?.value !== null
        ? String((hostNameRow.value as { value?: string }).value ?? "Host Agency")
        : "Host Agency");

    // Render the PDF HTML for the snapshot.
    const totalCents = quote.locked_price_cents
      ?? quote.estimate_price_cents
      ?? Math.round((quote.total_amount ?? 0) * 100);
    const rendered = renderQuotePdfHtml({
      quote_id: quote.id,
      kind,
      tenant_name: tenantName,
      host_agency_legal_name: hostName,
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
      variance_cents: varianceCents,
      priced_at: quote.priced_at ?? new Date().toISOString(),
      price_lock_expires_at: quote.price_lock_expires_at,
      validity_days: Number(process.env.QUOTE_ESTIMATE_VALIDITY_DAYS ?? 7),
    });

    const auditId = randomUUID();
    const acceptedAt = new Date().toISOString();
    const action = kind === "confirmed" ? "quote.accepted_confirmed" : "quote.accepted_estimate";

    logQuoteAuditStub({
      audit_id: auditId,
      action,
      quote_id: quote.id,
      tenant_id: ctx.tenant_id,
      kind,
      total_cents: totalCents,
      variance_cents: varianceCents,
      price_lock_token: quote.price_lock_token,
      price_lock_expires_at: quote.price_lock_expires_at,
      pdf_content_hash: rendered.content_hash,
      pdf_html_length: rendered.html.length,
    });

    const updatePayload: Record<string, unknown> = {
      status: "accepted",
      accepted_at: acceptedAt,
      customer_accepted_at: acceptedAt,
      customer_accepted_audit_id: auditId,
      updated_at: acceptedAt,
    };
    if (kind === "estimate") {
      updatePayload.customer_accepted_variance_cents = varianceCents;
    }

    const { data, error } = await db
      .from("quotes")
      .update(updatePayload)
      .eq("id", id)
      .select()
      .single();

    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({
      ...data,
      accepted_audit_id: auditId,
      kind,
      variance_cents: varianceCents,
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}

// BP26: legacy shim around writeAuditLog. Each caller passes action +
// tenant_id + various fields; the rest go into changes.
function logQuoteAuditStub(payload: Record<string, unknown>): void {
  const { action, tenant_id, quote_id, ...rest } = payload as {
    action?: string;
    tenant_id?: string;
    quote_id?: string;
  };
  void writeAuditLog({
    tenant_id: typeof tenant_id === "string" ? tenant_id : null,
    actor_type: "user",
    action: typeof action === "string" ? action : "unknown",
    resource_type: "quote",
    resource_id: typeof quote_id === "string" ? quote_id : null,
    changes: rest as Record<string, unknown>,
  });
}
