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
// The customer_accepted_audit_id column is populated with the same UUID
// used in the audit_log row so the snapshot is queryable by quote.

import { randomUUID } from "node:crypto";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { triggerMatchingSequences } from "@/lib/tasks/sequence-engine";
import { renderQuotePdfHtml } from "@/lib/quotes/render-pdf";
import { writeAuditLog } from "@/lib/audit/write";
import { respondToAuthError } from "@/lib/auth/respond";
import { selectRepresentativeOption } from "@/lib/quotes/representative-option";
import { dbErrorResponse } from "@/lib/api/db-error-response";

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
  contact_id: string | null;
  user_id: string | null;
}

// §38 — trip detail for the accepted-quote snapshot PDF comes from the
// representative quote_options row (customer-selected, else lowest index).
interface AcceptOption {
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

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "quotes", action: "accept" });
    const db = tenantClient(ctx);
    const adminDb = createServiceRoleClient();
    const { id } = await params;

    const { data: existing, error: fetchErr } = await db
      .from("quotes")
      .select(
        "id, tenant_id, status, price_kind, priced_at, price_lock_token, price_lock_expires_at, estimate_price_cents, locked_price_cents, contact_id, user_id",
      )
      .eq("id", id)
      .maybeSingle();

    if (fetchErr) return dbErrorResponse(fetchErr);
    if (!existing) return Response.json({ error: "not_found" }, { status: 404 });

    const quote = existing as QuoteRow;
    if (!["sent", "viewed"].includes(quote.status)) {
      return Response.json({ error: "quote_not_in_sent_or_viewed_status" }, { status: 409 });
    }

    const kind = quote.price_kind ?? "estimate";

    // D-091 Round-3 #47 — enforce price-lock expiry for CONFIRMED quotes.
    // Confirmed quotes carry a locked price that's only valid until
    // `price_lock_expires_at`. Accepting after expiry binds the system to a
    // price the cruise line no longer guarantees; the customer must be
    // re-quoted at the current cruise-line rate. Per §12.4, the customer-
    // visible status flips to expired/needs_requote, and the API surface
    // returns 409 so the client can render the "lock expired, request new
    // quote" UX.
    if (kind === "confirmed" && quote.price_lock_expires_at) {
      const expiresAt = new Date(quote.price_lock_expires_at).getTime();
      if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
        return Response.json(
          {
            error: "price_lock_expired",
            price_lock_expires_at: quote.price_lock_expires_at,
            message: "The locked price on this quote has expired. Please request an updated quote.",
          },
          { status: 409 },
        );
      }
    }

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
      // #1190: tenants has no "name" column — the display label is display_name.
      .from("tenants")
      .select("display_name, support_email")
      .eq("id", ctx.tenant_id)
      .maybeSingle();
    const tenantName = (tenantData as { display_name?: string } | null)?.display_name ?? "Sub-host";

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

    // §38 — trip detail lives on quote_options. Read this quote's options via
    // the tenant-scoped client (RLS) + an explicit quote_id filter and pick
    // the representative one (customer-selected, else lowest option_index).
    const { data: optionRows, error: optionsErr } = await db
      .from("quote_options")
      .select(
        "option_index, customer_selected, cruise_line, ship_name, sailing_date, duration_nights, cabin_category, passenger_count, total_amount_cents",
      )
      .eq("quote_id", id)
      .order("option_index", { ascending: true });
    if (optionsErr) return dbErrorResponse(optionsErr);
    const chosenOption = selectRepresentativeOption((optionRows ?? []) as AcceptOption[]);

    // Render the PDF HTML for the snapshot.
    const totalCents = quote.locked_price_cents
      ?? quote.estimate_price_cents
      ?? chosenOption?.total_amount_cents
      ?? 0;
    const rendered = renderQuotePdfHtml({
      quote_id: quote.id,
      kind,
      tenant_name: tenantName,
      host_agency_legal_name: hostName,
      customer_name: "Customer",
      cruise_line: chosenOption?.cruise_line ?? null,
      ship_name: chosenOption?.ship_name ?? null,
      sailing_date: chosenOption?.sailing_date ?? null,
      duration_nights: chosenOption?.duration_nights ?? null,
      cabin_category: chosenOption?.cabin_category ?? null,
      passenger_count: chosenOption?.passenger_count ?? null,
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

    await writeAuditLog({
      tenant_id: ctx.tenant_id,
      actor_type: "user",
      actor_user_id: user.id,
      action,
      resource_type: "quote",
      resource_id: quote.id,
      changes: {
        audit_id: auditId,
        kind,
        total_cents: totalCents,
        variance_cents: varianceCents,
        price_lock_token: quote.price_lock_token,
        price_lock_expires_at: quote.price_lock_expires_at,
        // D-091 Round-3 #48 — persist the FULL rendered HTML so a dispute
        // months later can reconstruct exactly what the customer accepted.
        // Pre-fix we wrote only the content hash + length, which proves
        // tampering after the fact but doesn't show the original content.
        // audit_log.changes is JSONB; ~30KB of HTML is well under the
        // common audit-log row size threshold the §38.8 dashboards watch.
        pdf_content_hash: rendered.content_hash,
        pdf_html_length: rendered.html.length,
        pdf_html: rendered.html,
      },
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

    // D-091 Round-3 #49 — CAS guard: filter on the same status set we
    // checked at line 69-71 so a concurrent acceptance can't race past
    // the read. `.in("status", ["sent","viewed"])` makes the update
    // atomic against the status field; chaining `.select("id")` gives
    // us the affected-row count to detect the lost race.
    const { data, error } = await db
      .from("quotes")
      .update(updatePayload)
      .eq("id", id)
      .in("status", ["sent", "viewed"])
      .select()
      .single();

    if (error) {
      // 0-row CAS mismatch arrives as PGRST116 ("Cannot coerce the result
      // to a single JSON object"). Both the audit log and the PDF content
      // hash above were captured before this point — they're an honest
      // record of the customer's view even if their acceptance lost the
      // race. The reconciliation surface lets ops link both audit rows to
      // the eventual winning acceptance.
      if (error.code === "PGRST116") {
        return Response.json({ error: "quote_status_changed_during_accept" }, { status: 409 });
      }
      return dbErrorResponse(error);
    }

    // §37.4.2 — fan-out task sequences whose trigger_event='quote_accepted'.
    // Non-fatal: a sequence-fan-out failure must not break quote acceptance.
    try {
      const { id: quoteId } = await params;
      await triggerMatchingSequences({
        tenant_id: ctx.tenant_id,
        trigger: "quote_accepted",
        record: { quote_id: quoteId },
        triggered_by_user_id: null,
        svc: db,
      });
    } catch (seqErr) {
      console.warn("[quotes/accept] sequence fan-out failed:", seqErr);
    }

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
