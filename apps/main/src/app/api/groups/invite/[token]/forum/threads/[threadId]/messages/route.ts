// §19.x — Anonymous invitee message list + post. Same no-session isolation
// model as forum/route.ts and forum/threads/route.ts (HMAC token →
// invitation_id → group_id chain).
//
// GET  /api/groups/invite/[token]/forum/threads/[threadId]/messages
//   Visible messages, plus this invitation's own submissions regardless of
//   moderation status — mirrors the forum_messages_select RLS policy's "own
//   rows, any status" rule (apps/main/supabase/migrations/20260530000000_
//   forums.sql), which the staff-facing route doesn't need to replicate at
//   the app layer since coordinators already see every status.
//
// POST /api/groups/invite/[token]/forum/threads/[threadId]/messages
//   Body: { content, parent_message_id? }. Same fail-closed Haiku moderation
//   pipeline as the staff-facing route (insertAndModerateForumMessage) —
//   guest messages aren't special-cased. Blocked for `not_going` invitees
//   (canPost), a locked forum/thread, or a sailed group (§19.10 parity with
//   the staff-facing route, which enforces this at post-time, not just
//   thread-creation time).

import { validateInviteTokenChecks1to4 } from "@/lib/groups/invitation-token-checks";
import { resolveGuestForum, resolveGuestThread } from "@/lib/forums/guest-forum";
import { canPost } from "@/lib/forums/permissions";
import { insertAndModerateForumMessage } from "@/lib/forums/post-message";
import { verifyEnvAtBoot } from "@/lib/env";
import { dbErrorResponse } from "@/lib/api/db-error-response";

type RouteProps = { params: Promise<{ token: string; threadId: string }> };

export async function GET(_req: Request, props: RouteProps): Promise<Response> {
  const { token, threadId } = await props.params;

  const check = await validateInviteTokenChecks1to4(token);
  if (!check.ok) return check.response;
  const { svc, invitation, group } = check;

  const { data: forum, error: forumErr } = await resolveGuestForum(svc, group.id, group.tenant_id);
  if (forumErr) return dbErrorResponse(forumErr);
  if (!forum) return Response.json({ error: "forum_not_found" }, { status: 404 });

  const { data: thread, error: threadErr } = await resolveGuestThread(svc, forum.id, threadId, group.tenant_id);
  if (threadErr) return dbErrorResponse(threadErr);
  if (!thread) return Response.json({ error: "thread_not_found" }, { status: 404 });

  const { data: messages, error } = await svc
    .from("forum_messages")
    .select("id, content, status, user_id, invitation_id, parent_message_id, created_at")
    .eq("thread_id", threadId)
    .eq("forum_id", forum.id)
    .eq("tenant_id", group.tenant_id)
    .or(`status.eq.visible,invitation_id.eq.${invitation.id}`)
    .order("created_at", { ascending: true });
  if (error) return dbErrorResponse(error);

  return Response.json({ messages: messages ?? [] });
}

export async function POST(req: Request, props: RouteProps): Promise<Response> {
  const { token, threadId } = await props.params;

  const check = await validateInviteTokenChecks1to4(token);
  if (!check.ok) return check.response;
  const { svc, invitation, group } = check;

  const { data: forum, error: forumErr } = await resolveGuestForum(svc, group.id, group.tenant_id);
  if (forumErr) return dbErrorResponse(forumErr);
  if (!forum) return Response.json({ error: "forum_not_found" }, { status: 404 });

  const { data: thread, error: threadErr } = await resolveGuestThread(svc, forum.id, threadId, group.tenant_id);
  if (threadErr) return dbErrorResponse(threadErr);
  if (!thread) return Response.json({ error: "thread_not_found" }, { status: 404 });

  const sailed = group.status === "sailed" || group.sailed_at !== null;
  if (sailed) {
    return Response.json({ error: "forum_read_only_post_sailing" }, { status: 410 });
  }

  const canPostMessage = canPost({
    user: { id: invitation.id, role: "guest", is_coordinator: false },
    forum,
    thread,
    muteState: null,
    invitation,
  });
  if (!canPostMessage) {
    return Response.json({ error: "posting_not_permitted" }, { status: 403 });
  }

  const body = await req.json() as { content: string; parent_message_id?: string };
  const env = verifyEnvAtBoot();

  const result = await insertAndModerateForumMessage(svc, {
    thread_id: threadId,
    tenant_id: group.tenant_id,
    forum_id: forum.id,
    author: { invitation_id: invitation.id },
    content: body.content,
    parent_message_id: body.parent_message_id,
    haikuTimeoutMs: env.FORUM_MODERATION_HAIKU_TIMEOUT_MS,
    haikuModel: env.HAIKU_FORUM_MODERATION_MODEL,
  });

  return Response.json(result.body, { status: result.status });
}
