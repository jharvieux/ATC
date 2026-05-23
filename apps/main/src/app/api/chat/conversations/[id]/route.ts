// §24.7 — Get a conversation with its messages (for resume after network drop).
//
// PATCH on the same path updates the draft field (chat compose box autosave).
// The conversations table doesn't have a draft column today; we store the
// most recent draft in localStorage on the client AND mirror to a draft row
// in messages with role='system' and a marker prefix. Simpler than a schema
// change, and the chat handler's POST clears it.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";

export async function GET(
  req: Request,
  ctxParams: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "Get conversation",
      action: "get",
    });
    const { id } = await ctxParams.params;
    const db = tenantClient(ctx);

    const { data: conv, error: convErr } = await db
      .from("conversations")
      .select("id, title, status, active_persona_id, last_message_at, message_count")
      .eq("id", id)
      .maybeSingle();
    if (convErr) return Response.json({ error: convErr.message }, { status: 500 });
    if (!conv) return Response.json({ error: "not_found" }, { status: 404 });

    const { data: msgs, error: msgErr } = await db
      .from("messages")
      .select("id, role, content, persona_id, rag_chunks_used, feedback_score, created_at")
      .eq("conversation_id", id)
      .order("created_at", { ascending: true })
      .limit(500);
    if (msgErr) return Response.json({ error: msgErr.message }, { status: 500 });

    return Response.json({ conversation: conv, messages: msgs ?? [] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

// PATCH = update conversation title (the only mutable field today).
export async function PATCH(
  req: Request,
  ctxParams: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "Update conversation",
      action: "patch",
    });
    const { id } = await ctxParams.params;
    const body = (await req.json()) as { title?: string };
    if (!body.title || body.title.length > 200) {
      return Response.json({ error: "invalid_title" }, { status: 400 });
    }
    const db = tenantClient(ctx);
    const { error } = await db
      .from("conversations")
      .update({ title: body.title })
      .eq("id", id);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}
