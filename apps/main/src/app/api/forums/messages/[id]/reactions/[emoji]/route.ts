// §19.5 — Delete a reaction (user's own only).

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

export async function DELETE(
  req: Request,
  { params }: { params: { id: string; emoji: string } },
): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "forums", action: "react" });
    const svc = createServiceRoleClient();

    const { error } = await svc
      .from("forum_reactions")
      .delete()
      .eq("message_id", params.id)
      .eq("user_id", user.id)
      .eq("emoji", params.emoji)
      .eq("tenant_id", ctx.tenant_id);

    if (error) return Response.json({ error: error.message }, { status: 500 });

    return Response.json({ ok: true });
  } catch (err) {
    console.error("[forum-reactions DELETE]", err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
}
