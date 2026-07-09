// §19.3–19.4 — Forum message post with fail-closed Haiku moderation contract.
//
// GET /api/forums/:forumId/threads/:threadId/messages
//   Returns all messages in the thread. Coordinators see every status;
//   non-coordinators see only status='visible'.
//
// POST /api/forums/:forumId/threads/:threadId/messages
//   Body: { content, parent_message_id? }
//
// Moderation status decision per max_score:
//   < 0.4   → visible
//   0.4–0.7 → flagged_review
//   > 0.7   → hidden
//
// Haiku failure → pending_moderation (fail-closed, emit retry event)
// PII pii_leak > 0.95 + credit_card_pattern → hidden + audit

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { canPost, forumCoordinatorId } from "@/lib/forums/permissions";
import { insertAndModerateForumMessage } from "@/lib/forums/post-message";
import { verifyEnvAtBoot } from "@/lib/env";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { effectiveVisibility, type VisibilityDefault } from "@/lib/groups/visibility";
import { deriveDisplayName } from "@/lib/groups/roster";

type RouteProps = { params: Promise<{ forumId: string; threadId: string }> };

// #1190-style normalization: supabase-js may return a to-one embed as an
// object or a single-element array depending on query shape.
function toOne<T>(rel: T | T[] | null | undefined): T | null {
  return (Array.isArray(rel) ? rel[0] : rel) ?? null;
}

export async function GET(req: Request, { params }: RouteProps): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "forums", action: "post_message" });
    const svc = createServiceRoleClient();
    const { forumId, threadId } = await params;

    const { data: forum, error: forumErr } = await svc
      .from("forums")
      // #1190: coordinator + visibility_default live on the linked group, not on forums.
      .select("tenant_id, groups(coordinator_user_id, visibility_default)")
      .eq("id", forumId)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    if (forumErr) return dbErrorResponse(forumErr);
    if (!forum) return Response.json({ error: "forum_not_found" }, { status: 404 });

    const isCoordinator = forumCoordinatorId(forum) === user.id;
    const group = toOne((forum as { groups?: { visibility_default: VisibilityDefault } | { visibility_default: VisibilityDefault }[] }).groups);
    const visibilityDefault: VisibilityDefault = group?.visibility_default ?? "visible";

    // Build base query; apply status filter before .order() so the Supabase
    // builder chain terminates cleanly regardless of coordinator status.
    // Guest (invitation-authored) messages join invitations for the display
    // name — one FK (invitation_id → invitations), so unambiguous.
    let baseQuery = svc
      .from("forum_messages")
      .select("id, content, status, user_id, invitation_id, parent_message_id, created_at, invitations(invitee_name, visibility_choice)", { count: "exact" })
      .eq("thread_id", threadId)
      .eq("forum_id", forumId)
      .eq("tenant_id", ctx.tenant_id);

    if (!isCoordinator) {
      baseQuery = baseQuery.eq("status", "visible");
    }

    // #1588: a lively thread can outgrow PostgREST's unbounded max-rows cap,
    // which would silently drop the OLDEST messages under the prior
    // ascending, unbounded order. Page from newest-first instead (so the
    // default page is always the most recent `limit` messages, never a
    // silently-truncated prefix), then reverse to the ascending order the
    // client renders in.
    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 500);
    const offset = Number(url.searchParams.get("offset") ?? 0);

    const { data: messages, error, count } = await baseQuery
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) return dbErrorResponse(error);

    const orderedMessages = (messages ?? []).slice().reverse();

    type MessageRow = {
      id: string; content: string; status: string; user_id: string | null;
      invitation_id: string | null; parent_message_id: string | null; created_at: string;
      invitations?: { invitee_name: string | null; visibility_choice: "no_opinion" | "be_anonymous" | "show_me_anyway" }
        | { invitee_name: string | null; visibility_choice: "no_opinion" | "be_anonymous" | "show_me_anyway" }[] | null;
    };

    const withAuthorName = (orderedMessages as MessageRow[]).map(({ invitations, ...m }) => {
      if (!m.invitation_id) return { ...m, author_name: null };
      const inv = toOne(invitations);
      const anonymous = effectiveVisibility(visibilityDefault, inv?.visibility_choice ?? "no_opinion") === "hidden";
      return { ...m, author_name: anonymous ? "Anonymous" : deriveDisplayName(inv?.invitee_name ?? null) };
    });

    return Response.json({ messages: withAuthorName, is_coordinator: isCoordinator, total: count ?? 0, limit, offset });
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function POST(
  req: Request,
  props: { params: Promise<{ forumId: string; threadId: string }> }
): Promise<Response> {
  const params = await props.params;
  try {
    const { ctx, user } = await assertPermission(req, { resource: "forums", action: "post_message" });
    const env = verifyEnvAtBoot();
    const svc = createServiceRoleClient();

    const { forumId, threadId } = params;

    // Load forum + thread (#1190: coordinator lives on the linked group).
    const { data: forum } = await svc.from("forums").select("*, groups(coordinator_user_id)").eq("id", forumId).eq("tenant_id", ctx.tenant_id).single();
    if (!forum) return Response.json({ error: "forum_not_found" }, { status: 404 });

    // D-091 Pattern 5 — add tenant_id filter (forum_id was already filtered
    // to a tenant-owned forum above, but the explicit tenant_id makes the
    // query self-contained).
    const { data: thread } = await svc.from("forum_threads").select("*").eq("id", threadId).eq("forum_id", forumId).eq("tenant_id", ctx.tenant_id).single();
    if (!thread) return Response.json({ error: "thread_not_found" }, { status: 404 });

    // §19.10 — Post-sailing forum read-only mode. Once the group has
    // sailed (sailed_at IS NOT NULL OR status='sailed'), the forum
    // transitions to read-only. Returns 410 Gone per the spec.
    const { data: group } = await svc
      .from("groups")
      .select("sailed_at, status")
      .eq("id", (forum as { group_id: string }).group_id)
      .maybeSingle();
    const sailed =
      group &&
      ((group as { sailed_at: string | null; status: string }).sailed_at !== null ||
        (group as { sailed_at: string | null; status: string }).status === "sailed");
    if (sailed) {
      return Response.json(
        { error: "forum_read_only_post_sailing" },
        { status: 410 },
      );
    }

    // Load mute state for this user
    const { data: muteState } = await svc
      .from("forum_user_state")
      .select("is_muted,muted_until")
      .eq("forum_id", forumId)
      .eq("user_id", user.id)
      .maybeSingle();

    // Load invitation for rsvp_state check.
    // invitations.invitee_email is an email string; user.auth_user_id is a UUID.
    // Resolve the email from public.users, then scope to this group (invitations
    // has no tenant_id — isolation is via group_id → groups.tenant_id).
    const { data: userRow, error: userEmailErr } = await svc
      .from("users")
      .select("email")
      .eq("id", user.id)
      .eq("tenant_id", ctx.tenant_id)
      .single();
    if (userEmailErr) throw new Error(`users.email lookup failed: ${userEmailErr.message}`);
    const { data: invitation } = await svc
      .from("invitations")
      .select("rsvp_state")
      .eq("group_id", (forum as { group_id: string }).group_id)
      .eq("invitee_email", (userRow as { email: string }).email)
      .is("token_revoked_at", null)
      .maybeSingle();

    const userPerms = {
      id: user.id,
      role: "member",
      is_coordinator: forumCoordinatorId(forum) === user.id,
    };

    if (!canPost({ user: userPerms, forum, thread, muteState, invitation })) {
      return Response.json({ error: "posting_not_permitted" }, { status: 403 });
    }

    const body = await req.json() as { content: string; parent_message_id?: string };
    const { content, parent_message_id } = body;

    const result = await insertAndModerateForumMessage(svc, {
      thread_id: threadId,
      tenant_id: ctx.tenant_id,
      forum_id: forumId,
      author: { user_id: user.id },
      content,
      parent_message_id,
      haikuTimeoutMs: env.FORUM_MODERATION_HAIKU_TIMEOUT_MS,
      haikuModel: env.HAIKU_FORUM_MODERATION_MODEL,
    });

    return Response.json(result.body, { status: result.status });
  } catch (err) {
    return respondToAuthError(err);
  }
}
