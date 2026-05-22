// §12.2 — Remove a contact relationship edge.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; rel_id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "contacts", action: "update" });
    const db = tenantClient(ctx);
    const { id: from_contact_id, rel_id } = await params;

    const { error } = await db
      .from("contact_relationships")
      .delete()
      .eq("id", rel_id)
      .eq("from_contact_id", from_contact_id);

    if (error) return Response.json({ error: error.message }, { status: 500 });
    return new Response(null, { status: 204 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}
