// §19.7 — Forum threads list and thread creation (coordinator portal).
//
// GET /api/forums/:forumId/threads
//   Returns non-deleted threads ordered by pinned-first, then created_at desc.
//   Coordinators see all threads; callers verified to be active tenant members.
//
// POST /api/forums/:forumId/threads
//   Body: { title: string }
//   Creates a new thread. Forum must not be locked.

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

type RouteProps = { params: Promise<{ forumId: string }> };

export async function GET(req: Request, { params }: RouteProps): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "forums", action: "post_message" });
    const svc = createServiceRoleClient();
    const { forumId } = await params;

    const { data: forum, error: fErr } = await svc
      .from("forums")
      .select("id, tenant_id")
      .eq("id", forumId)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    if (fErr) return dbErrorResponse(fErr);
    if (!forum) return Response.json({ error: "forum_not_found" }, { status: 404 });

    // #1588: explicit bound — PostgREST silently truncates an unlimited
    // select at its max-rows default, so a busy forum would lose threads
    // off the end with no signal. Same limit/offset shape as GET /api/crm/contacts.
    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const offset = Number(url.searchParams.get("offset") ?? 0);

    const { data: threads, error, count } = await svc
      .from("forum_threads")
      .select("id, title, is_locked, is_pinned, is_announcement, created_at, created_by_user_id", { count: "exact" })
      .eq("forum_id", forumId)
      .eq("tenant_id", ctx.tenant_id)
      .is("deleted_at", null)
      .order("is_pinned", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) return dbErrorResponse(error);
    return Response.json({ threads: threads ?? [], total: count ?? 0, limit, offset });
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function POST(req: Request, { params }: RouteProps): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "forums", action: "post_message" });
    const svc = createServiceRoleClient();
    const { forumId } = await params;

    const { data: forum, error: fErr } = await svc
      .from("forums")
      .select("id, is_locked, tenant_id")
      .eq("id", forumId)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    if (fErr) return dbErrorResponse(fErr);
    if (!forum) return Response.json({ error: "forum_not_found" }, { status: 404 });
    if (forum.is_locked) return Response.json({ error: "forum_locked" }, { status: 403 });

    const body = await req.json() as { title?: string };
    const title = body.title?.trim();
    if (!title) return Response.json({ error: "title_required" }, { status: 400 });

    const { data: thread, error: insertErr } = await svc
      .from("forum_threads")
      .insert({
        forum_id: forumId,
        tenant_id: ctx.tenant_id,
        created_by_user_id: user.id,
        title,
      })
      .select()
      .single();

    if (insertErr || !thread) {
      return dbErrorResponse(insertErr);
    }
    return Response.json(thread, { status: 201 });
  } catch (err) {
    return respondToAuthError(err);
  }
}
