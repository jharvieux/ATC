// §19.x — Anonymous invitee thread list + thread creation. Same no-session
// isolation model as forum/route.ts (HMAC token → invitation_id → group_id).
//
// GET  /api/groups/invite/[token]/forum/threads
// POST /api/groups/invite/[token]/forum/threads   Body: { title }
//   Blocked if the forum is locked or the group has sailed. The created
//   thread is attributed to the invitation, not a user (created_by_invitation_id).

import { validateInviteTokenChecks1to4 } from "@/lib/groups/invitation-token-checks";
import { resolveGuestForum } from "@/lib/forums/guest-forum";
import { canPost } from "@/lib/forums/permissions";
import { dbErrorResponse } from "@/lib/api/db-error-response";

type RouteProps = { params: Promise<{ token: string }> };

export async function GET(_req: Request, props: RouteProps): Promise<Response> {
  const { token } = await props.params;

  const check = await validateInviteTokenChecks1to4(token);
  if (!check.ok) return check.response;
  const { svc, group } = check;

  const { data: forum, error: forumErr } = await resolveGuestForum(svc, group.id, group.tenant_id);
  if (forumErr) return dbErrorResponse(forumErr);
  if (!forum) return Response.json({ error: "forum_not_found" }, { status: 404 });

  const { data: threads, error } = await svc
    .from("forum_threads")
    .select("id, title, is_locked, is_pinned, is_announcement, created_at")
    .eq("forum_id", forum.id)
    .eq("tenant_id", group.tenant_id)
    .is("deleted_at", null)
    .order("is_pinned", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) return dbErrorResponse(error);

  return Response.json({ threads: threads ?? [] });
}

export async function POST(req: Request, props: RouteProps): Promise<Response> {
  const { token } = await props.params;

  const check = await validateInviteTokenChecks1to4(token);
  if (!check.ok) return check.response;
  const { svc, invitation, group } = check;

  const { data: forum, error: forumErr } = await resolveGuestForum(svc, group.id, group.tenant_id);
  if (forumErr) return dbErrorResponse(forumErr);
  if (!forum) return Response.json({ error: "forum_not_found" }, { status: 404 });

  // §19.10-equivalent for the guest flow: a sailed group's forum goes
  // read-only. Checks both flags — the staff-facing message-post route
  // (apps/main/src/app/api/forums/[forumId]/threads/[threadId]/messages/
  // route.ts) treats them as independently sufficient, so a thread-creation
  // gate that only checked one would be a narrower guard than posting itself.
  const sailed = group.status === "sailed" || group.sailed_at !== null;
  if (sailed) {
    return Response.json(
      { error: "group_sailed", message: "This trip has sailed. New threads can no longer be created." },
      { status: 410 },
    );
  }

  const canCreate = canPost({
    user: { id: invitation.id, role: "guest", is_coordinator: false },
    forum,
    thread: { is_locked: false },
    muteState: null,
    invitation,
  });
  if (!canCreate) {
    return Response.json({ error: "posting_not_permitted" }, { status: 403 });
  }

  const body = await req.json() as { title?: string };
  const title = body.title?.trim();
  if (!title) return Response.json({ error: "title_required" }, { status: 400 });

  const { data: thread, error: insertErr } = await svc
    .from("forum_threads")
    .insert({
      forum_id: forum.id,
      tenant_id: group.tenant_id,
      created_by_invitation_id: invitation.id,
      title,
    })
    .select()
    .single();

  if (insertErr || !thread) return dbErrorResponse(insertErr);
  return Response.json(thread, { status: 201 });
}
