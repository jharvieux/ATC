// §12.4 — Mark quote as sent + render the binary PDF.
//
// On send we:
//   1. Mint customer_access_token if not already set (§38.4.3).
//   2. Render the binary PDF via @react-pdf/renderer (see lib/quotes/render-quote-pdf.tsx).
//      Disclosure copy mirrors lib/quotes/render-pdf.ts so the audit
//      snapshot and the customer-visible binary stay in sync.
//   3. Upload to the quote-pdfs bucket at tenant_<id>/<quote_id>.pdf.
//   4. Return a 7-day signed URL.

import { randomBytes } from "node:crypto";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { renderQuotePdf } from "@/lib/quotes/render-quote-pdf";

const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;
const QUOTE_PDF_BUCKET = "quote-pdfs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "quotes", action: "send" });
    const db = tenantClient(ctx);
    const adminDb = createServiceRoleClient();
    const { id } = await params;

    // Load the full quote row to build the PDF input.
    const { data: quoteRow, error: fetchErr } = await db
      .from("quotes")
      .select(
        "id, status, customer_access_token, cruise_line, ship_name, sailing_date, duration_nights, cabin_category, passenger_count, total_amount, locked_price_cents, estimate_price_cents, price_lock_expires_at, priced_at",
      )
      .eq("id", id)
      .maybeSingle();

    if (fetchErr) return Response.json({ error: fetchErr.message }, { status: 500 });
    if (!quoteRow) return Response.json({ error: "not_found" }, { status: 404 });
    if (quoteRow.status !== "draft") {
      return Response.json({ error: "quote_not_in_draft_status" }, { status: 409 });
    }

    const quote = quoteRow as {
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
    };

    const now = new Date().toISOString();
    const update: Record<string, unknown> = {
      status: "sent",
      sent_at: now,
      updated_at: now,
    };
    if (!quote.customer_access_token) {
      update.customer_access_token = randomBytes(32).toString("base64url");
    }
    const { data, error } = await db
      .from("quotes")
      .update(update)
      .eq("id", id)
      .select()
      .single();
    if (error) return Response.json({ error: error.message }, { status: 500 });

    // Lookups for tenant name + host agency display — same pattern as accept.
    const { data: tenantData } = await adminDb
      .from("tenants")
      .select("name")
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
      : typeof hostNameRow?.value === "object" && hostNameRow?.value !== null
        ? String((hostNameRow.value as { value?: string }).value ?? "Host Agency")
        : "Host Agency";

    // Build the render input. Pick kind based on whether the quote has
    // a locked price (confirmed) or only an estimate.
    const totalCents =
      quote.locked_price_cents ??
      quote.estimate_price_cents ??
      Math.round((quote.total_amount ?? 0) * 100);
    const kind: "confirmed" | "estimate" =
      quote.locked_price_cents != null ? "confirmed" : "estimate";

    let pdfUrl: string | null = null;
    try {
      const buf = await renderQuotePdf({
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
        variance_cents: Number(process.env.QUOTE_DEFAULT_VARIANCE_CENTS ?? 5000),
        priced_at: quote.priced_at ?? now,
        price_lock_expires_at: quote.price_lock_expires_at,
        validity_days: Number(process.env.QUOTE_ESTIMATE_VALIDITY_DAYS ?? 7),
      });

      const path = `tenant_${ctx.tenant_id}/${quote.id}.pdf`;
      const { error: upErr } = await adminDb.storage
        .from(QUOTE_PDF_BUCKET)
        .upload(path, buf, { contentType: "application/pdf", upsert: true });
      if (upErr) {
        console.warn("[quotes/send] PDF upload failed: %s", upErr.message);
      } else {
        const { data: signed } = await adminDb.storage
          .from(QUOTE_PDF_BUCKET)
          .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
        pdfUrl = signed?.signedUrl ?? null;
      }
    } catch (renderErr) {
      // PDF render is best-effort — the quote send itself already succeeded.
      console.warn(
        "[quotes/send] PDF render failed for %s: %s",
        quote.id,
        renderErr instanceof Error ? renderErr.message : String(renderErr),
      );
    }

    return Response.json({ quote: data, pdf_url: pdfUrl });
  } catch (err) {
    return respondToAuthError(err);
  }
}
