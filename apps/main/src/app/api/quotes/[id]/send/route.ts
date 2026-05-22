// §12.4 — Mark quote as sent.
// PDF rendering is deferred (TODO): returns a presigned URL placeholder per build prompt.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "quotes", action: "send" });
    const db = tenantClient(ctx);
    const { id } = await params;

    const { data: existing, error: fetchErr } = await db
      .from("quotes")
      .select("id, status")
      .eq("id", id)
      .maybeSingle();

    if (fetchErr) return Response.json({ error: fetchErr.message }, { status: 500 });
    if (!existing) return Response.json({ error: "not_found" }, { status: 404 });
    if (existing.status !== "draft") {
      return Response.json({ error: "quote_not_in_draft_status" }, { status: 409 });
    }

    const now = new Date().toISOString();
    const { data, error } = await db
      .from("quotes")
      .update({ status: "sent", sent_at: now, updated_at: now })
      .eq("id", id)
      .select()
      .single();

    if (error) return Response.json({ error: error.message }, { status: 500 });

    // TODO(pdf-rendering): generate PDF via @react-pdf/renderer and return a
    // signed URL. For now returns a placeholder per §12 build prompt.
    return Response.json({ quote: data, pdf_url: null, pdf_note: "PDF rendering deferred" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}
