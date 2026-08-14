import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { tenantClient } from "@/lib/db/tenant-client";
import { writeAuditLog } from "@/lib/audit/write";

const AGENCY_TIERS = new Set(["sub_agency", "byo_agency"]);

interface SearchIndexingRow {
  custom_domain: string | null;
  custom_domain_status: string;
  search_indexing_enabled: boolean;
  tier_id: string;
}

async function loadSetting(
  db: ReturnType<typeof tenantClient>,
  tenantId: string,
): Promise<
  | { response: Response }
  | { tenant: SearchIndexingRow; agencyEligible: boolean }
> {
  const { data: tenantData, error: tenantError } = await db
    .from("tenants")
    .select(
      "tier_id, custom_domain, custom_domain_status, search_indexing_enabled",
    )
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantError) return { response: dbErrorResponse(tenantError) };
  if (!tenantData) {
    return {
      response: Response.json({ error: "tenant_not_found" }, { status: 404 }),
    };
  }

  const tenant = tenantData as SearchIndexingRow;
  const { data: tierData, error: tierError } = await db
    .from("tier_definitions")
    .select("code")
    .eq("id", tenant.tier_id)
    .maybeSingle();
  if (tierError) return { response: dbErrorResponse(tierError) };

  return {
    tenant,
    agencyEligible:
      tierData != null &&
      AGENCY_TIERS.has((tierData as { code: string }).code),
  };
}

export async function GET(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await assertPermission(req, {
      resource: "tenant_branding",
      action: "read",
    });
  } catch (error) {
    return respondToAuthError(error);
  }

  const result = await loadSetting(tenantClient(auth.ctx), auth.ctx.tenant_id);
  if ("response" in result) return result.response;

  return Response.json({
    agency_eligible: result.agencyEligible,
    custom_domain: result.tenant.custom_domain,
    custom_domain_status: result.tenant.custom_domain_status,
    search_indexing_enabled: result.tenant.search_indexing_enabled,
  });
}

export async function POST(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await assertPermission(req, {
      resource: "tenant_branding",
      action: "write",
    });
  } catch (error) {
    return respondToAuthError(error);
  }

  let body: { search_indexing_enabled?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.search_indexing_enabled !== "boolean") {
    return Response.json(
      { error: "search_indexing_enabled_must_be_boolean" },
      { status: 422 },
    );
  }

  const db = tenantClient(auth.ctx);
  const result = await loadSetting(db, auth.ctx.tenant_id);
  if ("response" in result) return result.response;
  if (!result.agencyEligible) {
    return Response.json({ error: "agency_tier_required" }, { status: 403 });
  }
  if (
    body.search_indexing_enabled &&
    (!result.tenant.custom_domain ||
      result.tenant.custom_domain_status !== "verified")
  ) {
    return Response.json(
      { error: "verified_custom_domain_required" },
      { status: 409 },
    );
  }

  const { data: updated, error: updateError } = await db
    .from("tenants")
    .update({ search_indexing_enabled: body.search_indexing_enabled })
    .eq("id", auth.ctx.tenant_id)
    .select("search_indexing_enabled")
    .single();
  if (updateError || !updated) return dbErrorResponse(updateError);

  await writeAuditLog({
    tenant_id: auth.ctx.tenant_id,
    actor_user_id:
      auth.ctx.source.kind === "http_request"
        ? auth.ctx.source.user_id
        : null,
    actor_type: "user",
    action: "tenant.search_indexing.updated",
    resource_type: "tenant",
    resource_id: auth.ctx.tenant_id,
    changes: {
      before: {
        search_indexing_enabled: result.tenant.search_indexing_enabled,
      },
      after: {
        search_indexing_enabled: body.search_indexing_enabled,
      },
    },
  });

  return Response.json({
    search_indexing_enabled: (
      updated as { search_indexing_enabled: boolean }
    ).search_indexing_enabled,
  });
}
