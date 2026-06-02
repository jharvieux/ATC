// §14.3a — Sub-host subcontractor: update and archive.
//
// PATCH /api/subcontractors/:id — update name/share_rate
// DELETE /api/subcontractors/:id — soft-archive (sets archived_at)

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "subcontractors", action: "update" });
    const { id } = await params;
    const body = (await req.json()) as { name?: string; share_rate?: number };

    const updates: Record<string, unknown> = {};
    if (typeof body.name === "string") updates.name = body.name.trim();
    if (typeof body.share_rate === "number") {
      if (body.share_rate < 0 || body.share_rate > 1) {
        return Response.json(
          { error: "share_rate must be between 0 and 1" },
          { status: 400 },
        );
      }
      updates.share_rate = body.share_rate;
    }

    if (Object.keys(updates).length === 0) {
      return Response.json({ error: "No updatable fields provided" }, { status: 400 });
    }

    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("sub_host_subcontractors")
      .update(updates)
      .eq("id", id)
      .is("archived_at", null)
      .select("id, name, share_rate")
      .single();

    if (error) return Response.json({ error: error.message }, { status: 500 });
    if (!data) return Response.json({ error: "Subcontractor not found" }, { status: 404 });
    return Response.json({ subcontractor: data });
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "subcontractors", action: "delete" });
    const { id } = await params;

    const db = tenantClient(ctx);
    const { error } = await db
      .from("sub_host_subcontractors")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", id)
      .is("archived_at", null);

    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}
