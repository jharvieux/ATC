// §19.x — Anonymous invitee forum landing. No session/role check at all —
// isolation is the HMAC token → invitation_id → group_id chain, the same
// pattern as apps/main/src/app/api/groups/invite/[token]/rsvp/route.ts.
// Customers who only hold an invite token have no users row and no
// authenticated-customer-portal concept anywhere in this app (see the PR
// description for the rejected alternatives).
//
// GET /api/groups/invite/[token]/forum
//   Returns the forum for this invitation's group plus its thread list.
//   Full message bodies are a separate endpoint (forum/threads/[id]/messages).

import { validateInviteTokenChecks1to4 } from "@/lib/groups/invitation-token-checks";
import { resolveGuestForum } from "@/lib/forums/guest-forum";
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

  const { data: threads, error: threadsErr } = await svc
    .from("forum_threads")
    .select("id, title, is_locked, is_pinned, is_announcement, created_at")
    .eq("forum_id", forum.id)
    .eq("tenant_id", group.tenant_id)
    .is("deleted_at", null)
    .order("is_pinned", { ascending: false })
    .order("created_at", { ascending: false });
  if (threadsErr) return dbErrorResponse(threadsErr);

  return Response.json({ forum_id: forum.id, is_locked: forum.is_locked, threads: threads ?? [] });
}
