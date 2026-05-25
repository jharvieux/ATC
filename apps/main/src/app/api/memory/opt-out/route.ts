// §11.3 — POST /api/memory/opt-out
// Sets users.memory_opt_out = true for the authenticated user in this tenant.
// Future extraction jobs check this flag at the top of the handler and no-op.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { writeAuditLog } from "@/lib/audit/write";
import { respondToAuthError } from "@/lib/auth/respond";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, {
      resource: "CustomerMemory",
      action: "opt_out",
    });
    const db = tenantClient(ctx);

    const { error } = await db
      .from("users")
      .update({ memory_opt_out: true })
      .eq("id", user.id);

    if (error) return Response.json({ error: error.message }, { status: 500 });

    await writeAuditLog({
      tenant_id: ctx.tenant_id,
      actor_user_id: user.id,
      actor_type: "user",
      action: "customer_memory.opted_out",
      resource_type: "user",
      resource_id: user.id,
    });

    return Response.json({ status: "opted_out" });
  } catch (err) {
    return respondToAuthError(err);
  }
}
