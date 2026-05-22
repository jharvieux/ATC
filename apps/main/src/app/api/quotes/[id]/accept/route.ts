// §12.4 — Accept a quote (agent marks accepted or customer self-accepts).

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "quotes", action: "accept" });
    const db = tenantClient(ctx);
    const { id } = await params;

    const { data: existing, error: fetchErr } = await db
      .from("quotes")
      .select("id, status")
      .eq("id", id)
      .maybeSingle();

    if (fetchErr) return Response.json({ error: fetchErr.message }, { status: 500 });
    if (!existing) return Response.json({ error: "not_found" }, { status: 404 });
    if (!["sent", "viewed"].includes(existing.status)) {
      return Response.json({ error: "quote_not_in_sent_or_viewed_status" }, { status: 409 });
    }

    const now = new Date().toISOString();
    const { data, error } = await db
      .from("quotes")
      .update({ status: "accepted", accepted_at: now, updated_at: now })
      .eq("id", id)
      .select()
      .single();

    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}
