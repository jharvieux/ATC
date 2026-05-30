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
import { loadQuoteRenderInput } from "@/lib/quotes/build-render-input";

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

    const result = await loadQuoteRenderInput({
      ctx,
      db,
      adminDb,
      quoteId: id,
    });
    if (!result.ok) {
      return Response.json({ error: result.message }, { status: result.status });
    }

    const buf = await renderQuotePdf(result.input);

    return new Response(buf as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="quote-${result.quote.id}.pdf"`,
        // Force fresh — quote contents can change between downloads.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}
