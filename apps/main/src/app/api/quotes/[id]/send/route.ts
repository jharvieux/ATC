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
import {
  loadQuoteRow,
  buildRenderInputFromQuote,
} from "@/lib/quotes/build-render-input";
import { triggerMatchingSequences } from "@/lib/tasks/sequence-engine";

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

    // Cheap quote load first so non-draft sends 409 without paying the
    // tenant + platform_settings lookups.
    const loaded = await loadQuoteRow({ db, quoteId: id });
    if (!loaded.ok) {
      return Response.json({ error: loaded.message }, { status: loaded.status });
    }
    const { quote } = loaded;

    if (quote.status !== "draft") {
      return Response.json({ error: "quote_not_in_draft_status" }, { status: 409 });
    }

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

    // Now enrich with tenant + host for the render. Shared with /pdf so
    // the agent download and the customer-attachment PDF stay
    // byte-equivalent.
    const enriched = await buildRenderInputFromQuote({ ctx, adminDb, quote });
    if (!enriched.ok) {
      return Response.json({ error: enriched.message }, { status: enriched.status });
    }
    const renderInput = enriched.input;

    let pdfUrl: string | null = null;
    try {
      const buf = await renderQuotePdf(renderInput);

      const path = `tenant_${ctx.tenant_id}/${quote.id}.pdf`;
      const { error: upErr } = await adminDb.storage
        .from(QUOTE_PDF_BUCKET)
        .upload(path, buf, { contentType: "application/pdf", upsert: true });
      if (upErr) {
        console.warn("[quotes/send] PDF upload failed: %s", upErr.message);
      } else {
        const { data: signed, error: signedErr } = await adminDb.storage
          .from(QUOTE_PDF_BUCKET)
          .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
        if (signedErr) {
          console.warn(
            "[quotes/send] signed URL failed: %s",
            signedErr.message,
          );
        }
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

    // §37.4.2 — fan-out task sequences whose trigger_event='quote_sent'.
    // Non-fatal: a sequence-fan-out failure must not break quote send.
    try {
      await triggerMatchingSequences({
        tenant_id: ctx.tenant_id,
        trigger: "quote_sent",
        record: { quote_id: id },
        triggered_by_user_id: null,
        svc: db,
      });
    } catch (seqErr) {
      console.warn("[quotes/send] sequence fan-out failed:", seqErr);
    }

    return Response.json({ quote: data, pdf_url: pdfUrl });
  } catch (err) {
    return respondToAuthError(err);
  }
}
