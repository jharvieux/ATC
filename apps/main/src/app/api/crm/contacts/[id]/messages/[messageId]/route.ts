// §12 / #1756 — fetch a single inbound-email message's body for the draft
// composer's deep link. The CRM timeline's "Draft reply" link used to pass
// the full email body via a ?inquiry= URL param, which can exceed browser/
// proxy URL length limits on long inbound emails and silently truncate the
// pre-fill. The composer now links with the message id and fetches the
// body itself.
//
// Scoped to (contact, message): the message's conversation must belong to
// this contact, so a caller can't read an arbitrary tenant message by
// guessing an id — same two-layer isolation as the timeline route
// (app-level contact scoping + tenantClient's tenant_id scoping).

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "contacts", action: "read" });
    const db = tenantClient(ctx);
    const { id, messageId } = await params;

    // Bounded to match the timeline route's own conversations query (§12).
    const { data: conversations, error: convErr } = await db
      .from("conversations")
      .select("id")
      .eq("contact_id", id)
      .limit(50);
    if (convErr) return dbErrorResponse(convErr);
    const conversationIds = (conversations ?? []).map((c) => c.id);
    if (conversationIds.length === 0) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    const { data: message, error: msgErr } = await db
      .from("messages")
      .select("content, created_at")
      .eq("id", messageId)
      .in("conversation_id", conversationIds)
      .eq("source", "email")
      .maybeSingle();
    if (msgErr) return dbErrorResponse(msgErr);
    if (!message) return Response.json({ error: "not_found" }, { status: 404 });

    return Response.json({ content: message.content, created_at: message.created_at });
  } catch (err) {
    return respondToAuthError(err);
  }
}
