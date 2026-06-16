// §12.1 — Contact get + update.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const ContactPatchSchema = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  middle_name: z.string().optional(),
  preferred_name: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  date_of_birth: z.string().optional(),
  date_of_birth_is_estimated: z.boolean().optional(),
  estimation_basis: z.string().optional(),
  gender: z.string().optional(),
  nationality: z.string().optional(),
  passport_expiry: z.string().optional(),
  loyalty_programs: z.record(z.unknown()).optional(),
  dietary_restrictions: z.string().optional(),
  accessibility_needs: z.string().optional(),
  source: z.string().optional(),
  source_reference: z.string().optional(),
  pipeline_stage_key: z.string().nullable().optional(),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "contacts", action: "read" });
    const db = tenantClient(ctx);
    const { id } = await params;

    const { data, error } = await db.from("contacts").select("*").eq("id", id).maybeSingle();

    if (error) return dbErrorResponse(error);
    if (!data) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(data);
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "contacts", action: "update" });
    const db = tenantClient(ctx);
    const { id } = await params;

    const body = await req.json();
    const parsed = ContactPatchSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "Invalid body", details: parsed.error.issues }, { status: 400 });
    }

    const { data, error } = await db
      .from("contacts")
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) return dbErrorResponse(error);
    if (!data) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(data);
  } catch (err) {
    return respondToAuthError(err);
  }
}
