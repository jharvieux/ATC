// §12.4 — Mark quote as sent.
// PDF rendering is deferred (TODO): returns a presigned URL placeholder per build prompt.
// §38.4.3 — mints customer_access_token on first send for the public
// tokenized selection endpoint.

import { randomBytes } from "node:crypto";
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
      .select("id, status, customer_access_token")
      .eq("id", id)
      .maybeSingle();

    if (fetchErr) return Response.json({ error: fetchErr.message }, { status: 500 });
    if (!existing) return Response.json({ error: "not_found" }, { status: 404 });
    if (existing.status !== "draft") {
      return Response.json({ error: "quote_not_in_draft_status" }, { status: 409 });
    }

    const now = new Date().toISOString();
    const update: Record<string, unknown> = {
      status: "sent",
      sent_at: now,
      updated_at: now,
    };
    // §38.4.3 — mint customer_access_token if not already set; preserve
    // any prior token so re-sends don't invalidate URLs already shared.
    const row = existing as { customer_access_token: string | null };
    if (!row.customer_access_token) {
      update.customer_access_token = randomBytes(32).toString("base64url");
    }
    const { data, error } = await db
      .from("quotes")
      .update(update)
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
