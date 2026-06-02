// §19.5 — Forum message reactions (add/remove).
//
// POST   /api/forums/messages/:id/reactions      { emoji }
// DELETE /api/forums/messages/:id/reactions/:emoji

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { respondToAuthError } from "@/lib/auth/respond";

const ALLOWED_EMOJI = new Set(["thumbs_up", "heart", "laugh", "surprised", "celebrate", "eyes"]);

export async function POST(req: Request, props: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await props.params;
  try {
    const { ctx, user } = await assertPermission(req, { resource: "forums", action: "react" });
    const svc = createServiceRoleClient();
    const { emoji } = await req.json() as { emoji: string };

    if (!ALLOWED_EMOJI.has(emoji)) {
      return Response.json({ error: "invalid_emoji" }, { status: 400 });
    }

    const { data: msg } = await svc
      .from("forum_messages")
      .select("id,tenant_id,forum_id")
      .eq("id", params.id)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    if (!msg) return Response.json({ error: "message_not_found" }, { status: 404 });

    const { error } = await svc.from("forum_reactions").insert({
      message_id: params.id,
      user_id: user.id,
      tenant_id: ctx.tenant_id,
      emoji,
    });

    if (error?.code === "23505") {
      return Response.json({ error: "already_reacted" }, { status: 409 });
    }
    if (error) return Response.json({ error: error.message }, { status: 500 });

    return Response.json({ ok: true }, { status: 201 });
  } catch (err) {
    return respondToAuthError(err);
  }
}
