// §19.5 — Delete a reaction (user's own only).

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { respondToAuthError } from "@/lib/auth/respond";

export async function DELETE(req: Request, props: { params: Promise<{ id: string; emoji: string }> }): Promise<Response> {
  const params = await props.params;
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
    return respondToAuthError(err);
  }
}
