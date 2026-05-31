// §7.1 / §17.3 — Complete signup (tenant provisioning for platform-domain operator signups).
//
// Called by the tenant-signup onboarding UI after OAuth callback completes. At
// this point the caller has a valid Supabase session but NO public.users or
// public.tenants row yet — the callback deliberately skips the users upsert on
// the platform domain (x-resolved-tenant-id === "platform"). This route creates
// both rows and runs attribution binding.
//
// Not gated by assertPermission — no tenant context exists pre-provisioning.
// Auth is verified directly via getUser() on the session cookie.

import type { NextRequest } from "next/server";
import { createRequestScopedClient } from "@/lib/auth/ssr-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import {
  safeAwaitRequired,
  SupabaseMutationError,
} from "@/lib/db/safe-mutation";
import { publishTenantEvent } from "@/lib/rag-sync/publish-tenant-event";
import { bindContactOnIdentification } from "@/lib/attribution/bind-contact-on-identification";
import {
  readPendingAttributionFromHeader,
  ATTRIBUTION_PENDING_COOKIE,
} from "@/lib/attribution/read-pending-cookie";

const RESOLVED_TENANT_ID_HEADER = "x-resolved-tenant-id";
const VALID_TENANT_TYPES = new Set(["byo_host", "sub_host"]);

export async function POST(req: NextRequest): Promise<Response> {
  // Platform domain guard — this route only exists on the platform primary domain.
  // Tenant subdomains resolve to a UUID, not "platform".
  if (req.headers.get(RESOLVED_TENANT_ID_HEADER) !== "platform") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  // Verify session — the cookie was set by the OAuth callback.
  const supabase = createRequestScopedClient(req);
  const { data: authData, error: authErr } = await supabase.auth.getUser();
  if (authErr || !authData?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const authUserId = authData.user.id;
  const email = authData.user.email ?? null;
  if (!email) {
    return Response.json({ error: "email_required" }, { status: 400 });
  }

  // Parse body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const displayName = typeof b.display_name === "string" ? b.display_name.trim() : null;
  const legalName   = typeof b.legal_name   === "string" ? b.legal_name.trim()   : null;
  const slug        = typeof b.slug         === "string" ? b.slug.toLowerCase().trim() : null;
  const tenantType  = typeof b.tenant_type  === "string" ? b.tenant_type         : null;

  if (!displayName) return Response.json({ error: "display_name_required" }, { status: 400 });
  if (!legalName)   return Response.json({ error: "legal_name_required" },   { status: 400 });
  if (!slug)        return Response.json({ error: "slug_required" },          { status: 400 });
  if (!tenantType || !VALID_TENANT_TYPES.has(tenantType)) {
    return Response.json({ error: "tenant_type_invalid" }, { status: 400 });
  }

  const svc = createServiceRoleClient();

  // Idempotency guard — user must not already have a tenant row.
  const { data: existingUser } = await svc
    .from("users")
    .select("tenant_id")
    .eq("auth_user_id", authUserId)
    .limit(1)
    .maybeSingle();
  if (existingUser) {
    return Response.json({ error: "already_provisioned" }, { status: 409 });
  }

  // INSERT tenant — §17.3: status defaults to "onboarding"; onboarding_stage
  // is nullable with no default so set it to the first stage explicitly.
  let tenantId: string;
  try {
    const tenantRow = await safeAwaitRequired(
      svc
        .from("tenants")
        .insert({
          slug,
          display_name:     displayName,
          legal_name:       legalName,
          tenant_type:      tenantType,
          status:           "onboarding",
          onboarding_stage: "signup",
        })
        .select("id")
        .single(),
      "tenants.insert.signup_complete",
    );
    tenantId = (tenantRow as unknown as { id: string }).id;
  } catch (err) {
    if (err instanceof SupabaseMutationError && err.code === "23505") {
      return Response.json({ error: "slug_taken" }, { status: 409 });
    }
    console.error("[signup/complete] tenants.insert failed:", err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }

  // INSERT users row — role defaults to "tenant_owner" per migration 20260625000001.
  const userRow = await safeAwaitRequired(
    svc
      .from("users")
      .insert({
        auth_user_id: authUserId,
        tenant_id:    tenantId,
        email,
        status: "active",
      })
      .select("id")
      .single(),
    "users.insert.signup_complete",
  );
  const userId = (userRow as unknown as { id: string }).id;

  // Publish tenant.created — awaited; no void in serverless (D-091).
  await publishTenantEvent({
    event_type:      "tenant.created",
    tenant_id:       tenantId,
    source_revision: 0,
    payload: { status: "onboarding", tenant_type: tenantType, display_name: displayName },
  });

  // §35.2.2 attribution binding — awaited; no void in serverless (D-091).
  const pending = readPendingAttributionFromHeader(req.headers.get("cookie"));
  await bindContactOnIdentification({
    svc,
    tenant_id:       tenantId,
    user_id:         userId,
    source_origin:   pending ? "utm_parsed" : "agent_set",
    pending_payload: pending ?? null,
  });

  // Clear attribution pending cookie so a stale UTM doesn't attach to future sessions.
  const jsonRes = Response.json(
    { tenant_id: tenantId, slug, status: "onboarding", onboarding_stage: "signup" },
    { status: 201 },
  );
  const res = new Response(jsonRes.body, { status: jsonRes.status, headers: jsonRes.headers });
  res.headers.append(
    "Set-Cookie",
    `${ATTRIBUTION_PENDING_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
  );
  return res;
}
