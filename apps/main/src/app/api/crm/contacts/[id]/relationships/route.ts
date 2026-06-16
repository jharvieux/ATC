// §12.2 — List and add contact relationship edges.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

const RelationshipCreateSchema = z.object({
  to_contact_id: z.string().uuid(),
  relationship_type: z.string().min(1),
  notes: z.string().optional(),
  source: z.enum(["manual", "ai_inferred"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "contacts", action: "read" });
    const db = tenantClient(ctx);
    const { id: from_contact_id } = await params;

    const { data, error } = await db
      .from("contact_relationships")
      .select("id, to_contact_id, relationship_type, notes, source, confidence, created_at")
      .eq("from_contact_id", from_contact_id)
      .order("created_at", { ascending: true });

    if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    return Response.json({ relationships: data ?? [] });
  } catch (err) {
    return respondToAuthError(err);
  }
}

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
      return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    }

    return Response.json(data, { status: 201 });
  } catch (err) {
    return respondToAuthError(err);
  }
}
