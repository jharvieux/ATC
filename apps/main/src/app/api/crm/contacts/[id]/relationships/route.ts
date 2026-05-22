// §12.2 — Add a contact relationship edge.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";

const RelationshipCreateSchema = z.object({
  to_contact_id: z.string().uuid(),
  relationship_type: z.string().min(1),
  notes: z.string().optional(),
  source: z.enum(["manual", "ai_inferred"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "contacts", action: "update" });
    const db = tenantClient(ctx);
    const { id: from_contact_id } = await params;

    const body = await req.json();
    const parsed = RelationshipCreateSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "Invalid body", details: parsed.error.issues }, { status: 400 });
    }

    const { data, error } = await db
      .from("contact_relationships")
      .insert({ from_contact_id, ...parsed.data })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return Response.json({ error: "relationship_already_exists" }, { status: 409 });
      }
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json(data, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}
