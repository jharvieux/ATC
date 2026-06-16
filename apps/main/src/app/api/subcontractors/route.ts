// §14.3a — Sub-host subcontractor CRUD.
// Restricted to tenant_type = 'sub_host'. BYO-host tenants get 403.
//
// GET  /api/subcontractors — list active subcontractors
// POST /api/subcontractors — create a subcontractor

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "subcontractors", action: "read" });

    const adminDb = createServiceRoleClient();
    const { data: tenant } = await adminDb
      .from("tenants")
      .select("tenant_type")
      .eq("id", ctx.tenant_id)
      .single();

    if (!tenant || (tenant as { tenant_type: string }).tenant_type !== "sub_host") {
      return Response.json(
        { error: "Subcontractor tracking is only available for sub-host tenants." },
        { status: 403 },
      );
    }

    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("sub_host_subcontractors")
      .select("id, name, share_rate, created_at, archived_at")
      .is("archived_at", null)
      .order("name");

    if (error) return dbErrorResponse(error);
    return Response.json({ subcontractors: data ?? [] });
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "subcontractors", action: "create" });

    const adminDb = createServiceRoleClient();
    const { data: tenant } = await adminDb
      .from("tenants")
      .select("tenant_type")
      .eq("id", ctx.tenant_id)
      .single();

    if (!tenant || (tenant as { tenant_type: string }).tenant_type !== "sub_host") {
      return Response.json(
        { error: "Subcontractor tracking is only available for sub-host tenants." },
        { status: 403 },
      );
    }

    const body = (await req.json()) as { name?: string; share_rate?: number };
    const { name, share_rate } = body;

    if (!name || typeof share_rate !== "number") {
      return Response.json({ error: "Required: name (string), share_rate (0–1)" }, { status: 400 });
    }

    if (share_rate < 0 || share_rate > 1) {
      return Response.json(
        { error: "share_rate must be between 0 and 1 (e.g., 0.5 for 50%)" },
        { status: 400 },
      );
    }

    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("sub_host_subcontractors")
      .insert({ name: name.trim(), share_rate })
      .select("id, name, share_rate, created_at")
      .single();

    if (error) return dbErrorResponse(error);
    return Response.json({ subcontractor: data }, { status: 201 });
  } catch (err) {
    return respondToAuthError(err);
  }
}
