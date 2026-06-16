// §24.10 — Customer-requested escalation to a human.
//
// Body: { conversation_id: string, reason?: string }.
// Creates an escalation_topics row (initiated_by='customer') and sets the
// conversation status to 'escalated'. Notifying the tenant agent via the
// §23.8 in-app notification is wired through lib/notifications/create.ts.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { safeAwait } from "@/lib/db/safe-mutation";
import { guardConversationAccess, type ConversationAccessRow } from "@/lib/chat/guard-conversation-access";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "Escalate conversation",
      action: "post",
    });
    const body = (await req.json()) as { conversation_id?: string; reason?: string };
    const conversationId = String(body.conversation_id ?? "");
    if (!conversationId) {
      return Response.json({ error: "missing_conversation_id" }, { status: 400 });
    }

    const db = tenantClient(ctx);

    // #908 — caller must own the conversation (or be staff on a customer
    // thread): without this, any member could escalate anyone's thread.
    const { data: conv, error: convErr } = await db
      .from("conversations")
      .select("id, audience, user_id")
      .eq("id", conversationId)
      .maybeSingle();
    if (convErr) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    if (!conv) return Response.json({ error: "not_found" }, { status: 404 });
    const guard = await guardConversationAccess(db, ctx, conv as ConversationAccessRow);
    if (guard) return guard;

    const { error: esErr } = await db.from("escalation_topics").insert({
      conversation_id: conversationId,
      topic_summary: body.reason?.toString().slice(0, 500) ?? "Customer requested human handoff",
      topic_tags: ["customer_requested"],
      status: "open",
      initiated_by: "customer",
      initiated_reason: "customer_clicked_escalate",
    });
    if (esErr) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });

    await safeAwait(db
      .from("conversations")
      .update({ status: "escalated", last_message_at: new Date().toISOString() })
      .eq("id", conversationId), "conversations.update");

    // System transcript entry surfaced to the customer in the UI.
    await safeAwait(db.from("messages").insert({
      conversation_id: conversationId,
      role: "system",
      content:
        "Thanks for chatting! I'm bringing in someone from the team — they'll be in touch shortly.",
    }), "messages.insert");

    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}
