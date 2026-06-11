// #712 — Personal access token revocation.
//
// DELETE /api/integrations/tokens/[id] — revoke a token by ID.
//
// Owners can revoke any token in the tenant (e.g. a departed agent's token).
// The token is soft-deleted (revoked_at set); the hash row stays for audit.

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwaitRowCount } from "@/lib/db/safe-mutation";
import { respondToAuthError } from "@/lib/auth/respond";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "api_tokens", action: "revoke" });
    const { id } = await params;

    const svc = createServiceRoleClient();

    // Verify the token belongs to this tenant before revoking.
    const { data: existing, error: readErr } = await svc
      .from("personal_access_tokens")
      .select("id, revoked_at")
      .eq("id", id)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();

    if (readErr) return Response.json({ error: readErr.message }, { status: 500 });
    if (!existing) return Response.json({ error: "Token not found" }, { status: 404 });
    if ((existing as { revoked_at: string | null }).revoked_at) {
      return Response.json({ error: "Token is already revoked" }, { status: 409 });
    }

    await safeAwaitRowCount(
      svc
        .from("personal_access_tokens")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", id)
        .eq("tenant_id", ctx.tenant_id)
        .is("revoked_at", null)
        .select("id"),
      "personal_access_tokens.revoke",
      1,
    );

    return new Response(null, { status: 204 });
  } catch (err) {
    return respondToAuthError(err);
  }
}
