// §12.4 / §21.10.1 / §38.5 — Agent-facing quote PDF download.
//
// GET /api/quotes/[id]/pdf
//
// Streams the same binary PDF the customer receives via /api/quotes/[id]/send,
// on demand. Reuses loadQuoteRenderInput so the agent download and the
// customer email attachment stay byte-equivalent. No status gate: the agent
// can download at any quote stage (draft, sent, accepted, expired).
//
// The renderer (renderQuotePdf) requires Node runtime; same as /send.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { renderQuotePdf } from "@/lib/quotes/render-quote-pdf";
import {
  loadQuoteRow,
  buildRenderInputFromQuote,
} from "@/lib/quotes/build-render-input";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "quotes",
      action: "read",
    });
    const db = tenantClient(ctx);
    const adminDb = createServiceRoleClient();
    const { id } = await params;

    const loaded = await loadQuoteRow({ db, quoteId: id, tenant_id: ctx.tenant_id });
    if (!loaded.ok) {
      if (loaded.status !== 500) {
        return Response.json({ error: "quote_not_found" }, { status: loaded.status });
      }
      const ref = crypto.randomUUID();
      console.error("[quotes/pdf] ref=%s quote_load_failed", ref, loaded.message);
      return Response.json({ error: "quote_load_failed", ref }, { status: 500 });
    }
    const enriched = await buildRenderInputFromQuote({
      ctx,
      adminDb,
      quote: loaded.quote,
    });
    if (!enriched.ok) {
      const ref = crypto.randomUUID();
      console.error("[quotes/pdf] ref=%s render_input_failed", ref, enriched.message);
      return Response.json({ error: "render_input_failed", ref }, { status: 500 });
    }

    const buf = await renderQuotePdf(enriched.input);

    return new Response(buf as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="quote-${loaded.quote.id}.pdf"`,
        // Force fresh — quote contents can change between downloads.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}
