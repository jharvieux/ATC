// Spec ref: §5.4.5
//
// TenantContext is constructible ONLY through these four factory functions,
// one per provenance kind. Each is responsible for:
//   - verifying caller authority for the named tenant_id
//   - attaching the correct `source` discriminant
//   - recording context construction to audit_log for the stripe_webhook
//     and platform_admin cases (high-trust paths)
//
// `tenantContextFromRequest` is implemented; the other three are stubs
// that throw — they're wired up in BP04, BP07, and §26 work respectively.
//
// Implementation note: the http_request factory uses the user's JWT
// (anon-key client + Authorization header) rather than the service-role
// key. This keeps the lint rule (§5.4.4) honest: service-role-client is
// only imported by tenant-client.ts and platform-admin-client.ts. The
// membership check survives because RLS lets a user SELECT their own
// users row.

import { createClient } from "@supabase/supabase-js";
import type { TenantContext } from "./tenant-context";

const RESOLVED_TENANT_ID_HEADER = "x-resolved-tenant-id";

/**
 * Derives a tenant context from an HTTP request. Until middleware (BP04)
 * lands, the resolved tenant id is expected on the `x-resolved-tenant-id`
 * header and the user's access token on the standard Authorization Bearer
 * header. We verify the user has an active `users` row for the named
 * tenant — this is done under the user's own JWT so RLS applies.
 */
export async function tenantContextFromRequest(
  req: Request,
): Promise<TenantContext> {
  const tenantId = req.headers.get(RESOLVED_TENANT_ID_HEADER);
  if (!tenantId) {
    throw new Error(
      `tenantContextFromRequest: missing ${RESOLVED_TENANT_ID_HEADER} ` +
        `header. Middleware (BP04) should set this before route handlers run.`,
    );
  }
  // Platform routes (host === PLATFORM_PRIMARY_DOMAIN) resolve to "platform"
  // rather than a UUID. These routes must use withPlatformAdminAudit, not
  // tenantClient — they do not have a single scoped tenant.
  if (tenantId === "platform") {
    throw new Error(
      "tenantContextFromRequest: x-resolved-tenant-id is 'platform'. " +
        "Platform admin routes must use withPlatformAdminAudit instead of tenantClient.",
    );
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error(
      "tenantContextFromRequest: missing or malformed Authorization Bearer token.",
    );
  }
  const accessToken = authHeader.slice("Bearer ".length);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "tenantContextFromRequest: Supabase env not configured (verifyEnvAtBoot should have caught this).",
    );
  }

  // Anon-key client + user JWT in the Authorization header → RLS applies
  // with the user's identity. The user can SELECT their own users row by
  // policy from migration 0003.
  const supabase = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    throw new Error(
      "tenantContextFromRequest: invalid or expired access token.",
    );
  }
  const authUserId = userData.user.id;

  const { data: row, error } = await supabase
    .from("users")
    .select("id, status")
    .eq("auth_user_id", authUserId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `tenantContextFromRequest: failed to verify user-tenant membership: ${error.message}`,
    );
  }
  if (!row || row.status !== "active") {
    throw new Error(
      "tenantContextFromRequest: authenticated user is not an active member of the resolved tenant.",
    );
  }

  return {
    tenant_id: tenantId,
    source: { kind: "http_request", user_id: authUserId },
  };
}

/**
 * STUB — implementation lands in BP07 (Stripe webhook handler). When
 * implemented, derives the tenant from event metadata or by looking up
 * the stripe_customer_id, and writes the construction to audit_log.
 */
export async function tenantContextFromStripeEvent(
  _event: unknown,
): Promise<TenantContext> {
  throw new Error(
    "tenantContextFromStripeEvent: not implemented (lands in BP07).",
  );
}

/**
 * STUB — implementation lands when Inngest jobs are wired up. When
 * implemented, derives tenant from the event payload (which MUST include
 * tenant_id; jobs without one use platformAdminClient instead).
 */
export async function tenantContextFromInngestEvent(
  _event: unknown,
): Promise<TenantContext> {
  throw new Error(
    "tenantContextFromInngestEvent: not implemented (lands in future Inngest work).",
  );
}

/**
 * STUB — implementation lands alongside the audit_log table (Section 26).
 * When implemented, verifies admin identity, attaches the platform_admin
 * source discriminant, and records construction to audit_log with the
 * supplied reason.
 */
export async function tenantContextForPlatformAdmin(
  _admin: { user_id: string },
  _target_tenant_id: string,
  _reason: string,
): Promise<TenantContext> {
  throw new Error(
    "tenantContextForPlatformAdmin: not implemented (lands with audit_log in §26 work).",
  );
}
