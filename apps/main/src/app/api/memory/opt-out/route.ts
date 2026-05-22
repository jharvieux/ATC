// §11.3 — POST /api/memory/opt-out
// Sets users.memory_opt_out = true for the authenticated user in this tenant.
// Future extraction jobs check this flag at the top of the handler and no-op.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";

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

    console.warn("[audit-log:STUB]", JSON.stringify({
      action: "customer_memory.opted_out",
      tenant_id: ctx.tenant_id,
      user_id: user.id,
      ts: new Date().toISOString(),
    }));

    return Response.json({ status: "opted_out" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}
