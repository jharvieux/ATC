// §7.1 / §17.3 — Complete signup (tenant provisioning for platform-domain operator signups).
//
// Called by the tenant-signup onboarding UI after OAuth callback completes. At
// this point the caller has a valid Supabase session but NO public.users or
// public.tenants row yet — the callback deliberately skips the users upsert on
// the platform domain (x-resolved-tenant-id === "platform"). This route creates
// both rows, stores the full business profile (collects it up-front so the operator
// lands on /onboarding/legal rather than a redundant profile step), and runs
// attribution binding.
//
// Not gated by assertPermission — no tenant context exists pre-provisioning.
// Auth is verified directly via getUser() on the session cookie.

import { NextRequest, NextResponse } from "next/server";
import { createRequestScopedClient } from "@/lib/auth/ssr-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import {
  safeAwait,
  safeAwaitRequired,
  SupabaseMutationError,
} from "@/lib/db/safe-mutation";
import { publishTenantEvent } from "@/lib/rag-sync/publish-tenant-event";
import { bindContactOnIdentification } from "@/lib/attribution/bind-contact-on-identification";
import {
  readPendingAttributionFromHeader,
  clearPendingAttributionCookie,
} from "@/lib/attribution/read-pending-cookie";
import { progressTo } from "@/lib/onboarding/state-machine";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";

const VALID_TENANT_TYPES = new Set(["byo_host", "sub_host"]);

interface MailingAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  // Platform domain guard — this route only exists on the platform primary domain.
  // Tenant subdomains resolve to a UUID, not "platform".
  if (req.headers.get(RESOLVED_TENANT_ID_HEADER) !== "platform") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const displayName    = typeof b.display_name   === "string" ? b.display_name.trim()            : null;
  const legalName      = typeof b.legal_name     === "string" ? b.legal_name.trim()              : null;
  const slug           = typeof b.slug           === "string" ? b.slug.toLowerCase().trim()      : null;
  const tenantType     = typeof b.tenant_type    === "string" ? b.tenant_type                    : null;
  const supportEmail   = typeof b.support_email  === "string" ? b.support_email.trim()           : null;
  const supportPhone   = typeof b.support_phone  === "string" ? b.support_phone.trim() || null   : null;
  const timezone       = typeof b.timezone       === "string" ? b.timezone                       : null;
  const mailingAddress = (b.mailing_address && typeof b.mailing_address === "object")
    ? b.mailing_address as MailingAddress
    : null;

  if (!displayName)  return Response.json({ error: "display_name_required" },  { status: 400 });
  if (!legalName)    return Response.json({ error: "legal_name_required" },    { status: 400 });
  if (!slug)         return Response.json({ error: "slug_required" },           { status: 400 });
  if (!supportEmail) return Response.json({ error: "support_email_required" }, { status: 400 });
  if (!timezone)     return Response.json({ error: "timezone_required" },      { status: 400 });
  if (!mailingAddress?.line1 || !mailingAddress?.city || !mailingAddress?.state || !mailingAddress?.zip) {
    return Response.json({ error: "mailing_address_required" }, { status: 400 });
  }
  if (!tenantType || !VALID_TENANT_TYPES.has(tenantType)) {
    return Response.json({ error: "tenant_type_invalid" }, { status: 400 });
  }

  const svc = createServiceRoleClient();

  // Idempotency guard — fail-closed: safeAwait throws on DB error so a DB
  // hiccup returns 500 rather than silently passing the guard.
  let existingUser: unknown;
  try {
    existingUser = await safeAwait(
      svc.from("users").select("tenant_id").eq("auth_user_id", authUserId).limit(1).maybeSingle(),
      "users.select.idempotency_check",
    );
  } catch (err) {
    console.error("[signup/complete] idempotency guard query failed:", err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }
  if (existingUser) {
    return Response.json({ error: "already_provisioned" }, { status: 409 });
  }

  // INSERT tenant with full profile — §17.3: status defaults to "onboarding".
  // Profile data collected up-front so we can advance straight to "legal" stage.
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
          support_email:    supportEmail,
          support_phone:    supportPhone,
          timezone,
          mailing_address:  mailingAddress,
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

  // role defaults to "tenant_owner" per migration 20260625000001.
  // Wrapped in try/catch: if this fails the tenant row above is already committed.
  // The hard-delete trigger (prevent_tenant_hard_delete) blocks programmatic
  // rollback, so we log the orphaned tenant_id for ops to manually clean up.
  let userId: string;
  try {
    const userRow = await safeAwaitRequired(
      svc
        .from("users")
        .insert({ auth_user_id: authUserId, tenant_id: tenantId, email, status: "active" })
        .select("id")
        .single(),
      "users.insert.signup_complete",
    );
    userId = (userRow as unknown as { id: string }).id;
  } catch (err) {
    console.error("[signup/complete] users.insert failed after tenant committed; orphaned tenant_id:", tenantId, err);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }

  // Advance onboarding stage: signup → profile → legal.
  // Two calls required — state machine allows only one step forward at a time.
  // If either throws (StaleStageError, DB error) the tenant and user rows are
  // already committed. Log the tenantId for ops recovery and return a retriable
  // error code distinct from already_provisioned.
  try {
    await progressTo(tenantId, "profile");
    await progressTo(tenantId, "legal");
  } catch (err) {
    console.error("[signup/complete] stage advance failed; tenant committed, needs ops recovery:", tenantId, err);
    return Response.json({ error: "stage_advance_failed" }, { status: 500 });
  }

  // Publish tenant.created — awaited; no void in serverless (D-091).
  await publishTenantEvent({
    event_type:      "tenant.created",
    tenant_id:       tenantId,
    source_revision: 0,
    payload: { status: "onboarding", tenant_type: tenantType, display_name: displayName },
  });

  // §35.2.2 attribution binding — awaited; no void in serverless (D-091).
  const pending = readPendingAttributionFromHeader(req.headers.get("cookie"));
  const bindResult = await bindContactOnIdentification({
    svc,
    tenant_id:       tenantId,
    user_id:         userId,
    source_origin:   pending ? "utm_parsed" : "agent_set",
    pending_payload: pending ?? null,
  });
  if (!bindResult.ok) {
    console.warn("[signup/complete] attribution binding failed:", bindResult.error);
  }

  const res = NextResponse.json(
    { tenant_id: tenantId, slug, status: "onboarding", onboarding_stage: "legal" },
    { status: 201 },
  );
  clearPendingAttributionCookie(res);
  return res;
}
