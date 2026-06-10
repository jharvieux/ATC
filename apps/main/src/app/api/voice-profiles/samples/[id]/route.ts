// #903 — Delete a voice sample.
//
// RLS has DELETE=false on voice_samples (service-role only), so deletions
// bypass RLS via the service-role client. The app layer enforces ownership:
// only the sample's owner or a tenant_owner may delete it (two-layer per D-091).

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { safeAwait } from "@/lib/db/safe-mutation";
import { inngest } from "@/inngest/client";

export async function DELETE(
  req: Request,
  ctxParams: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "voice_profile", action: "write" });
    const { id } = await ctxParams.params;
    const db = tenantClient(ctx);
    const svc = createServiceRoleClient();
    const authUserId = ctx.source.kind === "http_request" ? ctx.source.user_id : null;

    const { data: urow, error: uErr } = await db // d091-allow:service-role-tenant — db is tenantClient(ctx) not svc; proxy auto-injects tenant_id
      .from("users").select("id, role").eq("auth_user_id", authUserId ?? "").maybeSingle();
    if (uErr) return Response.json({ error: uErr.message }, { status: 500 });
    const publicUserId = (urow as { id: string } | null)?.id ?? null;
    const role = (urow as { role?: string } | null)?.role ?? "";

    // Load the sample to verify ownership before deleting.
    const { data: sample, error: loadErr } = await db
      .from("voice_samples")
      .select("id, tenant_id, user_id")
      .eq("id", id)
      .maybeSingle();
    if (loadErr) return Response.json({ error: loadErr.message }, { status: 500 });
    if (!sample) return Response.json({ error: "not_found" }, { status: 404 });

    const s = sample as { id: string; tenant_id: string; user_id: string | null };

    // Ownership check: must be the sample's owner OR a tenant_owner (for house style).
    const isOwner = s.user_id === publicUserId;
    const isHouseStyle = s.user_id === null;
    const canDelete = isOwner || (isHouseStyle && role === "tenant_owner");
    if (!canDelete) return Response.json({ error: "not_found" }, { status: 404 });

    // Delete via service-role (RLS DELETE=false).
    await safeAwait(
      svc.from("voice_samples").delete().eq("id", id).eq("tenant_id", ctx.tenant_id),
      "voice_samples.delete",
    );

    // Re-trigger extraction so the card reflects the removed sample.
    await inngest.send({
      name: "voice_profile.extraction_requested",
      data: { tenant_id: ctx.tenant_id, user_id: s.user_id },
    });

    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}
