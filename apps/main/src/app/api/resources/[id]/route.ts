// BP39 §39.3 / §39.7 — Edit / publish the trip resources page.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { writeAuditLog } from "@/lib/audit/write";
import { newAccessToken } from "@/lib/deliverables/token";
import { respondToAuthError } from "@/lib/auth/respond";

const PatchSchema = z.object({
  sections: z.array(z.unknown()).optional(),
  agent_contact: z.unknown().optional(),
  packing_checklist: z.string().optional(),
  publish: z.boolean().optional(),
  rotate_token: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "bookings.resources", action: "update" });
    const { id } = await params;
    const svc = createServiceRoleClient();

    const body = await req.json();
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_body", details: parsed.error.issues }, { status: 400 });
    }

    const { data: rowData } = await svc
      .from("trip_resources")
      .select("id, tenant_id, status")
      .eq("id", id)
      .maybeSingle();
    if (!rowData) return Response.json({ error: "not_found" }, { status: 404 });
    const row = rowData as { tenant_id: string; status: string };
    if (row.tenant_id !== ctx.tenant_id) return Response.json({ error: "forbidden" }, { status: 403 });

    const update: Record<string, unknown> = {
      ...(parsed.data.sections !== undefined ? { sections: parsed.data.sections } : {}),
      ...(parsed.data.agent_contact !== undefined ? { agent_contact: parsed.data.agent_contact } : {}),
      ...(parsed.data.packing_checklist !== undefined ? { packing_checklist: parsed.data.packing_checklist } : {}),
      updated_at: new Date().toISOString(),
    };
    if (parsed.data.rotate_token) update.access_token = newAccessToken();
    if (parsed.data.publish) {
      update.status = "published";
      update.published_at = new Date().toISOString();
    }

    const { data, error } = await svc
      .from("trip_resources")
      .update(update)
      .eq("id", id)
      .select()
      .single();
    if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });

    if (parsed.data.publish) {
      await writeAuditLog({
        tenant_id: row.tenant_id,
        actor_user_id: user.id,
        actor_type: "user",
        action: "resources.published",
        resource_type: "trip_resources",
        resource_id: id,
      });
    }
    return Response.json(data);
  } catch (err) {
    return respondToAuthError(err);
  }
}
