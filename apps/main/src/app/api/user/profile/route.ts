// §25.3 right-to-correct — customer profile read + update.
//
// GET   /api/user/profile  → returns first_name, last_name, display_name,
//                            email (read-only — email is the OAuth identity).
// PATCH /api/user/profile  → updates first_name, last_name, display_name.
//                            Email cannot be edited here; that requires
//                            re-authentication through the OAuth provider.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { writeAuditLog } from "@/lib/audit/write";
import { respondToAuthError } from "@/lib/auth/respond";
import { safeAwait } from "@/lib/db/safe-mutation";

const ProfilePatchSchema = z.object({
  first_name: z.string().max(120).nullable().optional(),
  last_name: z.string().max(120).nullable().optional(),
  display_name: z.string().max(120).nullable().optional(),
}).strict();

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, {
      resource: "UserProfile",
      action: "read",
    });
    const db = tenantClient(ctx);

    const { data, error } = await db
      .from("users")
      .select("email, first_name, last_name, display_name, auth_provider")
      .eq("id", user.id)
      .maybeSingle();

    if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    if (!data) return Response.json({ error: "profile_not_found" }, { status: 404 });

    return Response.json(data);
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function PATCH(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, {
      resource: "UserProfile",
      action: "update",
    });

    const body: unknown = await req.json().catch(() => null);
    const parsed = ProfilePatchSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
    }
    if (Object.keys(parsed.data).length === 0) {
      return Response.json({ error: "no_fields_to_update" }, { status: 400 });
    }

    const db = tenantClient(ctx);
    const now = new Date().toISOString();

    await safeAwait(
      db.from("users")
        .update({ ...parsed.data, updated_at: now })
        .eq("id", user.id),
      "users.profile_update",
    );

    await writeAuditLog({
      tenant_id: ctx.tenant_id,
      actor_user_id: user.id,
      actor_type: "user",
      action: "user_profile.updated",
      resource_type: "user",
      resource_id: user.id,
      changes: { fields_changed: Object.keys(parsed.data) },
    });

    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}
