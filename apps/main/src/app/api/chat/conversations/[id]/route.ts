// §24.7 — Get a conversation with its messages (for resume after network drop).
//
// PATCH on the same path updates the draft field (chat compose box autosave).
// The conversations table doesn't have a draft column today; we store the
// most recent draft in localStorage on the client AND mirror to a draft row
// in messages with role='system' and a marker prefix. Simpler than a schema
// change, and the chat handler's POST clears it.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
// #908 — owner-or-staff guard (supersedes #902's local TA-only guard; customer
// threads were tenant-wide readable until this).
import { guardConversationAccess, type ConversationAccessRow } from "@/lib/chat/guard-conversation-access";
import { dbErrorResponse } from "@/lib/api/db-error-response";

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
      .select("id, title, status, active_persona_id, last_message_at, message_count, audience, user_id")
      .eq("id", id)
      .maybeSingle();
    if (convErr) return dbErrorResponse(convErr);
    if (!conv) return Response.json({ error: "not_found" }, { status: 404 });
    const guard = await guardConversationAccess(db, ctx, conv as ConversationAccessRow);
    if (guard) return guard;

    const { data: msgs, error: msgErr } = await db
      .from("messages")
      .select("id, role, content, persona_id, rag_chunks_used, feedback_score, created_at")
      .eq("conversation_id", id)
      .order("created_at", { ascending: true })
      .limit(500);
    if (msgErr) return dbErrorResponse(msgErr);

    return Response.json({ conversation: conv, messages: msgs ?? [] });
  } catch (err) {
    return respondToAuthError(err);
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
    const { data: conv, error: convErr } = await db
      .from("conversations")
      .select("id, audience, user_id")
      .eq("id", id)
      .maybeSingle();
    if (convErr) return dbErrorResponse(convErr);
    if (!conv) return Response.json({ error: "not_found" }, { status: 404 });
    const guard = await guardConversationAccess(db, ctx, conv as ConversationAccessRow);
    if (guard) return guard;

    const { error } = await db
      .from("conversations")
      .update({ title: body.title })
      .eq("id", id);
    if (error) return dbErrorResponse(error);
    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}
