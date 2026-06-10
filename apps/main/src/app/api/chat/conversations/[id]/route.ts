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
import type { TenantContext } from "@/lib/db/tenant-context";

type AudienceRow = { audience: string; user_id: string | null };

// #902 / D-195 — own-only visibility for TA-mode threads, enforced at the app
// layer: conversations RLS is tenant-scoped only (auth_user_in_tenant), so
// without this check ANY member — including viewer-role customers — could read
// a TA thread (commission talk, margin strategy) by id. 404, not 403, so the
// thread's existence isn't leaked. Fail closed: an unresolvable caller id
// never matches. (The same tenant-wide readability also affects CUSTOMER
// threads — pre-existing, tracked separately; see the #902 PR's linked issue.)
async function guardTaThread(
  db: ReturnType<typeof tenantClient>,
  ctx: TenantContext,
  conv: AudienceRow,
): Promise<Response | null> {
  if (conv.audience !== "tenant_member") return null;
  const authUserId = ctx.source.kind === "http_request" ? ctx.source.user_id : null;
  if (!authUserId) return Response.json({ error: "not_found" }, { status: 404 });
  const { data: urow, error } = await db
    .from("users")
    .select("id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (error || !urow || (urow as { id: string }).id !== conv.user_id) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return null;
}

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
    if (convErr) return Response.json({ error: convErr.message }, { status: 500 });
    if (!conv) return Response.json({ error: "not_found" }, { status: 404 });
    const guard = await guardTaThread(db, ctx, conv as AudienceRow);
    if (guard) return guard;

    const { data: msgs, error: msgErr } = await db
      .from("messages")
      .select("id, role, content, persona_id, rag_chunks_used, feedback_score, created_at")
      .eq("conversation_id", id)
      .order("created_at", { ascending: true })
      .limit(500);
    if (msgErr) return Response.json({ error: msgErr.message }, { status: 500 });

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
    if (convErr) return Response.json({ error: convErr.message }, { status: 500 });
    if (!conv) return Response.json({ error: "not_found" }, { status: 404 });
    const guard = await guardTaThread(db, ctx, conv as AudienceRow);
    if (guard) return guard;

    const { error } = await db
      .from("conversations")
      .update({ title: body.title })
      .eq("id", id);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}
