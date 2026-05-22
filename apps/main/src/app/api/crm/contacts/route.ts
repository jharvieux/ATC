// §12.1 — Contacts list + create.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";

const ContactCreateSchema = z.object({
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
  pipeline_stage_key: z.string().optional(),
  user_id: z.string().uuid().optional(),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "contacts", action: "list" });
    const db = tenantClient(ctx);

    const url = new URL(req.url);
    const pipeline_stage_key = url.searchParams.get("pipeline_stage_key");
    const search = url.searchParams.get("search");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const offset = Number(url.searchParams.get("offset") ?? 0);

    let query = db.from("contacts").select("*", { count: "exact" });

    if (pipeline_stage_key) query = query.eq("pipeline_stage_key", pipeline_stage_key);
    if (search) {
      query = query.or(
        `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`,
      );
    }

    const { data, error, count } = await query
      .order("last_name", { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ contacts: data, total: count, limit, offset });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "contacts", action: "create" });
    const db = tenantClient(ctx);

    const body = await req.json();
    const parsed = ContactCreateSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "Invalid body", details: parsed.error.issues }, { status: 400 });
    }

    const { data, error } = await db
      .from("contacts")
      .insert({ ...parsed.data, created_by_user_id: user.id })
      .select()
      .single();

    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json(data, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}
