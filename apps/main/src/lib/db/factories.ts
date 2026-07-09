// Spec ref: §5.4.5
//
// TenantContext is constructible ONLY through these four factory functions,
// one per provenance kind. Each is responsible for:
//   - verifying caller authority for the named tenant_id
//   - attaching the correct `source` discriminant
//   - recording context construction to audit_log for the stripe_webhook
//     and platform_admin cases (high-trust paths)
//
// Implementation note: the http_request factory uses the user's JWT (anon-key
// client + the session cookies, via @supabase/ssr) rather than the service-
// role key. This keeps the lint rule (§5.4.4) honest: service-role-client is
// only imported by tenant-client.ts and platform-admin-client.ts. The
// membership check survives because RLS lets a user SELECT their own users
// row.

import "server-only";

import type { TenantContext } from "./tenant-context";
import { tryTestBypass } from "../auth/test-bypass";
import { createRequestScopedClient, createBearerClient, extractBearerToken } from "../auth/ssr-client";
import { RESOLVED_TENANT_ID_HEADER } from "../tenancy/header-names";

/**
 * Derives a tenant context from an HTTP request. Middleware (proxy.ts) sets
 * `x-resolved-tenant-id` from the host. Auth is resolved from either an
 * `Authorization: Bearer <token>` header (extension/iOS Shortcut paths) or
 * the HttpOnly session cookies set by /api/auth/callback (browser paths). We
 * verify the user has an active `users` row for the named tenant under the
 * user's own JWT so RLS applies.
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

  // Tier-2 E2E auth bypass — see lib/auth/test-bypass.ts. Still header-based
  // (cookies aren't a Tier-2 thing); short-circuits before the cookie session.
  const bypass = tryTestBypass(req);
  if (bypass) {
    if (bypass.tenant_id !== tenantId) {
      throw new Error(
        `tenantContextFromRequest [test-bypass]: header tenant_id (${tenantId}) ` +
          `does not match TEST_AUTH_BYPASS_TENANT_ID (${bypass.tenant_id}).`,
      );
    }
    return {
      tenant_id: tenantId,
      source: { kind: "http_request", user_id: bypass.auth_user_id },
    };
  }

  const bearerToken = extractBearerToken(req);
  const supabase = bearerToken
    ? createBearerClient(bearerToken)
    : createRequestScopedClient(req);

  const { data: userData, error: userErr } = bearerToken
    ? await supabase.auth.getUser(bearerToken)
    : await supabase.auth.getUser();
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
 * Custom error thrown when a webhook event can't be mapped to a tenant.
 * The caller (webhook route handler) should return a 4xx so the provider
 * stops retrying — a missing mapping won't resolve on retry.
 */
export class WebhookContextNotFoundError extends Error {
  readonly code = "webhook_context_not_found" as const;
}

/**
 * §26.3a.4 — Derive tenant context from a Stripe webhook event.
 *
 * Resolution order:
 *   1. event.account (Connect events) → tenants.stripe_connect_account_id
 *   2. event.data.object.customer (Subscription/Invoice events) →
 *      tenants.stripe_customer_id
 *
 * Every resolution writes an audit_log row so a spoofed webhook that
 * resolves to an unexpected tenant is forensically detectable.
 */
export async function tenantContextFromStripeEvent(event: {
  id: string;
  type: string;
  account?: string;
  data?: { object?: { customer?: string } };
}): Promise<TenantContext> {
  const { createServiceRoleClient } = await import("./service-role-client");
  const { writeAuditLog } = await import("@/lib/audit/write");
  const db = createServiceRoleClient();

  let tenant_id: string | null = null;
  let resolved_via: "stripe_connect_account_id" | "stripe_customer_id" | null = null;

  if (event.account) {
    const { data } = await db
      .from("tenants")
      .select("id")
      .eq("stripe_connect_account_id", event.account)
      .maybeSingle();
    if (data) {
      tenant_id = (data as { id: string }).id;
      resolved_via = "stripe_connect_account_id";
    }
  }
  if (!tenant_id && event.data?.object?.customer) {
    const { data } = await db
      .from("tenants")
      .select("id")
      .eq("stripe_customer_id", event.data.object.customer)
      .maybeSingle();
    if (data) {
      tenant_id = (data as { id: string }).id;
      resolved_via = "stripe_customer_id";
    }
  }
  if (!tenant_id) {
    throw new WebhookContextNotFoundError(
      `Stripe event ${event.type} (${event.id}) cannot be resolved to a tenant.`,
    );
  }

  await writeAuditLog({
    tenant_id,
    actor_type: "system",
    action: "webhook.context_resolved",
    resource_type: "webhook",
    changes: {
      provider: "stripe",
      event_type: event.type,
      event_id: event.id,
      resolved_via,
    },
  });

  return {
    tenant_id,
    source: { kind: "stripe_webhook", stripe_event_id: event.id },
  };
}

/**
 * §26.3a.4 — Derive tenant context from a Resend webhook event by joining
 * email_log on resend_message_id.
 */
export async function tenantContextFromResendEvent(event: {
  id: string;
  type: string;
  data?: { email_id?: string };
}): Promise<TenantContext> {
  const { createServiceRoleClient } = await import("./service-role-client");
  const { writeAuditLog } = await import("@/lib/audit/write");
  const messageId = event.data?.email_id;
  if (!messageId) {
    throw new WebhookContextNotFoundError(
      `Resend event ${event.type} (${event.id}) has no email_id; cannot resolve tenant.`,
    );
  }
  const db = createServiceRoleClient();
  const { data } = await db
    .from("email_log")
    .select("tenant_id")
    .eq("resend_message_id", messageId)
    .maybeSingle();
  const tenant_id = (data as { tenant_id?: string } | null)?.tenant_id ?? null;
  if (!tenant_id) {
    throw new WebhookContextNotFoundError(
      `Resend message_id ${messageId} not found in email_log.`,
    );
  }
  await writeAuditLog({
    tenant_id,
    actor_type: "system",
    action: "webhook.context_resolved",
    resource_type: "webhook",
    changes: { provider: "resend", event_type: event.type, event_id: event.id },
  });
  return {
    tenant_id,
    // Resend doesn't have a dedicated source kind in TenantContext yet;
    // synthesize via inngest_job for now since the resend handler emits
    // inngest events downstream. Future TenantContext source extension
    // would add 'resend_webhook'.
    source: { kind: "inngest_job", function_name: "resend.webhook", event_id: event.id },
  };
}

/**
 * Derives a tenant context from an Inngest event payload.
 *
 * MANDATORY SCOPE CONTRACT (§11.2.2 / §5.4.5):
 *   tenant_id is sourced ONLY from event.data.tenant_id.
 *   NEVER from a user lookup, a request header, or any derived field.
 *   This is the sole authoritative source for background-job tenant scope.
 *   Any deviation produces the worst-case shape of cross-tenant leak.
 */
export function tenantContextFromInngestEvent(event: {
  id: string;
  name: string;
  data: Record<string, unknown>;
}): TenantContext {
  const tenant_id = event.data.tenant_id;
  if (!tenant_id || typeof tenant_id !== "string") {
    throw new Error(
      "tenantContextFromInngestEvent: event.data.tenant_id is missing or not a string. " +
        "All background jobs MUST carry tenant_id in the event payload.",
    );
  }
  return {
    tenant_id,
    source: {
      kind: "inngest_job",
      function_name: event.name,
      event_id: event.id,
    },
  };
}

/**
 * Superseded by `withPlatformAdminAudit` in
 * `@/lib/db/platform-admin-client`, which wraps the same admin-context
 * + audit_log write pattern. Kept as a throwing stub to surface any
 * caller still on the old API.
 */
export async function tenantContextForPlatformAdmin(
  _admin: { user_id: string },
  _target_tenant_id: string,
  _reason: string,
): Promise<TenantContext> {
  throw new Error(
    "tenantContextForPlatformAdmin: superseded by withPlatformAdminAudit.",
  );
}

// F1 — Construct a TenantContext for /api/public/chat/[token].
//
// The token is the credential. We've already resolved it to a tenant via
// resolvePublicToken before this is called — the caller passes in the
// resolved tenant_id and the SHA-256 hex of the token (NOT the raw
// token) so audit / supervisor writes can name the session without
// leaking the credential.
//
// Sync (not async) because there's no DB lookup left to do — the caller
// has already validated. Naming intentionally short — this is the only
// path callers should use.
export function tenantContextForPublicTokenChat(args: {
  tenant_id: string;
  token_hash: string;
}): TenantContext {
  if (!args.tenant_id || !/^[0-9a-f]{8}-/i.test(args.tenant_id)) {
    throw new Error(`tenantContextForPublicTokenChat: invalid tenant_id`);
  }
  if (!args.token_hash || !/^[0-9a-f]{64}$/.test(args.token_hash)) {
    throw new Error(`tenantContextForPublicTokenChat: token_hash must be 64-char hex SHA-256`);
  }
  return {
    tenant_id: args.tenant_id,
    source: { kind: "public_token_chat", token_hash: args.token_hash },
  };
}
