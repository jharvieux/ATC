// Spec ref: §7.9 / §26.3 (assertPermission canonical contract) + §26.2 RBAC
//
// assertPermission verifies three things:
//   1. The caller is an authenticated, active member of the resolved tenant.
//   2. For sensitive routes (§17.7 / §26.3 re-auth list), the JWT's
//      `auth_time` claim is ≤ 4 hours old. Otherwise throws AuthReauthRequired
//      with a structured shape so the client can redirect to /auth/reauth?return=...
//   3. The caller's role grants the requested (resource, action) per the
//      permission matrix in ./permission-grants.ts. Otherwise throws
//      AuthForbidden (403).
//
// Prior to 2026-05-25, step 3 was a stub (audit Finding 5, Medium severity):
// the function logged the pair and proceeded. Every "permission-gated"
// mutating route was therefore open to any active tenant member, regardless
// of role.

import "server-only";

import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { tenantContextFromRequest } from "@/lib/db/factories";
import type { TenantContext } from "@/lib/db/tenant-context";
import {
  isSensitiveRoute,
  SENSITIVE_SESSION_MAX_AGE_MS,
} from "./sensitive-routes";
import { tryTestBypass } from "./test-bypass";
import { isPermitted, type UserRole } from "./permission-grants";
import { getConsentPending, type PendingConsent } from "@/lib/consent/pending";
import { createRequestScopedClient, createBearerClient, extractBearerToken } from "./ssr-client";
import { getCachedUser } from "./get-cached-user";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";
import { safeAwait } from "@/lib/db/safe-mutation";

export type User = {
  id: string;
  auth_user_id: string;
  tenant_id: string;
  status: string;
  role: UserRole;
};

/**
 * Structured forbidden error — caller's role lacks the requested grant.
 * Route handlers should catch this and return a 403.
 */
export class AuthForbidden extends Error {
  readonly code = "forbidden" as const;
  constructor(
    public readonly resource: string,
    public readonly action: string,
    public readonly role: string,
  ) {
    super(`Role '${role}' is not permitted to ${action} ${resource}.`);
  }
}

/**
 * Structured re-auth required error. Route handlers should catch this and
 * return a 401 with `{ error: "reauth_required", return_to }`.
 */
export class AuthReauthRequired extends Error {
  readonly code = "reauth_required" as const;
  readonly return_to: string;
  constructor(return_to: string) {
    super("Sensitive action requires re-authentication (auth_time > 4h).");
    this.return_to = return_to;
  }
}

/**
 * §17.4 — Pending consent gate. Thrown when the caller has rows in
 * user_consent_pending (a new legal document version was published since
 * their last acceptance). Spec says ANY authenticated request other than
 * /consent + /logout + /legal/* must be redirected to /consent. The session
 * lives in HttpOnly cookies (§17.x) but the consent check needs the
 * authenticated user id, which only exists after getUser — so the gate
 * enforces here in assertPermission, where verification has already run.
 *
 * The consent acceptance endpoints (/api/user/consent and
 * /api/user/consent/pending) use Supabase auth directly without going
 * through assertPermission, so they're naturally exempt — the user can
 * still POST their acceptance while every other surface is gated.
 */
export class ConsentPendingError extends Error {
  readonly code = "consent_pending" as const;
  readonly return_to: string;
  readonly pending: PendingConsent[];
  constructor(return_to: string, pending: PendingConsent[]) {
    super(
      `Pending consent renewal required for ${pending.length} document(s).`,
    );
    this.return_to = return_to;
    this.pending = pending;
  }
}

interface AssertPermissionOpts {
  resource: string;
  action: string;
}

// #712 — 5-minute throttle on last_used_at writes to avoid a DB write on every request.
const PAT_LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export async function assertPermission(
  req: Request,
  opts: AssertPermissionOpts,
): Promise<{ ctx: TenantContext; user: User }> {
  // Tier-2 E2E auth bypass — only fires when NODE_ENV !== production AND
  // TEST_AUTH_BYPASS_TOKEN is set AND the request carries the matching
  // Bearer. Skips both the GoTrue call AND the post-bypass users-row
  // lookup (the lookup would need PostgREST in front of local Postgres,
  // which Tier-2 deliberately avoids — the seed script is the source of
  // truth that the user exists; tests that need richer user state should
  // assert it themselves). See lib/auth/test-bypass.ts.
  //
  // Bypassed users get role='tenant_owner' so all grants succeed during
  // Tier-2 E2E. To exercise RBAC denial in tests, instantiate a real user
  // with a non-owner role and use a real session JWT.
  const bypass = tryTestBypass(req);
  if (bypass) {
    const ctxBypass = await tenantContextFromRequest(req);
    const syntheticUser: User = {
      id: process.env.TEST_AUTH_BYPASS_PUBLIC_USER_ID ?? bypass.auth_user_id,
      auth_user_id: bypass.auth_user_id,
      tenant_id: bypass.tenant_id,
      status: "active",
      role: "tenant_owner",
    };
    return { ctx: ctxBypass, user: syntheticUser };
  }

  const pathname = new URL(req.url).pathname;
  const bearerToken = extractBearerToken(req);

  // #712 — Personal access token path. PATs are NOT Supabase JWTs, so they
  // must be intercepted here before tenantContextFromRequest calls auth.getUser(),
  // which would fail trying to verify a non-JWT bearer token.
  if (bearerToken?.startsWith("atc_pat_")) {
    return assertPermissionWithPAT(req, bearerToken, pathname, opts);
  }

  const ctx = await tenantContextFromRequest(req);

  // Bearer token path — used by the browser extension and iOS Shortcut.
  // These clients cannot set HttpOnly cookies; they authenticate via
  // `Authorization: Bearer <jwt>`. tenantContextFromRequest already
  // verified the JWT and membership; ctx.source.user_id is the confirmed
  // auth_user_id — no second getUser() call needed.
  // Sensitive routes (§17.7) require a browser re-auth UI that external
  // clients don't have, so they are hard-blocked here.
  if (bearerToken) {
    if (isSensitiveRoute(pathname)) {
      throw new AuthReauthRequired(pathname);
    }
    if (ctx.source.kind !== "http_request") {
      throw new Error("assertPermission: bearer path: unexpected context source kind.");
    }
    const authUserId = ctx.source.user_id;
    const pending = await getConsentPending(authUserId);
    if (pending.length > 0) {
      throw new ConsentPendingError(pathname, pending);
    }
    // A second users-row SELECT is unavoidable: tenantContextFromRequest's
    // membership check only fetches `id, status`; we need `role` for RBAC.
    const supabase = createBearerClient(bearerToken);
    const { data: bearerRow, error: bearerRowErr } = await supabase
      .from("users")
      .select("id, auth_user_id, tenant_id, status, role")
      .eq("auth_user_id", authUserId)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    if (bearerRowErr) {
      throw new Error(`assertPermission: DB error: ${bearerRowErr.message}`);
    }
    if (!bearerRow || (bearerRow as { status: string }).status !== "active") {
      throw new Error(
        "assertPermission: user is not an active member of the resolved tenant.",
      );
    }
    const bearerUser = bearerRow as User;
    if (!isPermitted(bearerUser.role, opts.resource, opts.action)) {
      throw new AuthForbidden(opts.resource, opts.action, bearerUser.role);
    }
    return { ctx, user: bearerUser };
  }

  // #679 — getCachedUser shares one supabase.auth.getUser() round-trip
  // with the (tenant)/layout's getSiteHeaderProps for server-rendered
  // pages. On pure /api/* routes there's no layout above, so the cache
  // is a no-op but harmless. The cached client uses a placeholder
  // request shape but the same Cookie header, so the verified JWT
  // payload is identical to what a `req`-bound client would produce.
  const { user: authUser } = await getCachedUser();
  if (!authUser) {
    throw new Error("assertPermission: invalid or expired access token.");
  }

  // Separate supabase client for the sensitive-routes getSession() below.
  // Both clients build from the same incoming Cookie header, so the
  // session payload is identical to what the cached client would see —
  // see the "SAFETY DEPENDS ON CALL ORDER" block on the getSession use.
  const supabase = createRequestScopedClient(req);

  // §17.4 Versioned consent gate. If the caller has pending user_consent_pending
  // rows (new document version published since their last acceptance), block
  // every authenticated action other than the consent acceptance flow itself.
  // The /api/user/consent and /api/user/consent/pending routes don't go
  // through assertPermission, so this doesn't deadlock the user out of
  // accepting; downstream they'll catch ConsentPendingError, return 403 with
  // `consent_pending` + return_to, and the client routes to /consent.
  const pending = await getConsentPending(authUser.id);
  if (pending.length > 0) {
    throw new ConsentPendingError(pathname, pending);
  }

  // §26.3 sensitive-action re-auth check. The access_token now lives in the
  // session cookie; pull it out via getSession() (cheap — cookie parse only,
  // no network) and decode auth_time.
  //
  // SAFETY DEPENDS ON CALL ORDER: getSession reads the cookie payload WITHOUT
  // verifying the JWT signature. We trust the payload only because getCachedUser
  // above just verified the same token bytes against the auth server in the
  // same request — both supabase clients (the cached one inside getCachedUser
  // and `supabase` here) build from the same incoming Cookie header, so the
  // session payload is identical to what was verified. Do NOT reorder this
  // block above the getCachedUser call, and do NOT use getSession in this file
  // for any other purpose.
  if (isSensitiveRoute(pathname)) {
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token ?? null;
    const authTime = accessToken ? readAuthTime(accessToken) : null;
    if (authTime === null) {
      throw new AuthReauthRequired(pathname);
    }
    const ageMs = Date.now() - authTime * 1000;
    if (ageMs > SENSITIVE_SESSION_MAX_AGE_MS) {
      throw new AuthReauthRequired(pathname);
    }
  }

  const { data: row, error } = await supabase
    .from("users")
    .select("id, auth_user_id, tenant_id, status, role")
    .eq("auth_user_id", authUser.id)
    .eq("tenant_id", ctx.tenant_id)
    .maybeSingle();

  if (error) {
    throw new Error(`assertPermission: DB error: ${error.message}`);
  }
  if (!row || row.status !== "active") {
    throw new Error(
      "assertPermission: user is not an active member of the resolved tenant.",
    );
  }

  const user = row as User;

  // §26.2 RBAC check — deny if the user's role lacks the (resource, action)
  // grant in permission-grants.ts. Closes audit Finding 5.
  if (!isPermitted(user.role, opts.resource, opts.action)) {
    throw new AuthForbidden(opts.resource, opts.action, user.role);
  }

  return { ctx, user };
}

// ---------------------------------------------------------------------------
// #712 — Personal access token auth path
// ---------------------------------------------------------------------------

type PatRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  scopes: string[];
  revoked_at: string | null;
  last_used_at: string | null;
};

async function assertPermissionWithPAT(
  req: Request,
  rawToken: string,
  pathname: string,
  opts: AssertPermissionOpts,
): Promise<{ ctx: TenantContext; user: User }> {
  // Sensitive routes are hard-blocked for all non-session auth.
  if (isSensitiveRoute(pathname)) {
    throw new AuthReauthRequired(pathname);
  }

  const tenantId = req.headers.get(RESOLVED_TENANT_ID_HEADER);
  if (!tenantId || tenantId === "platform") {
    throw new Error("assertPermission: PAT path: missing or platform tenant context.");
  }

  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const svc = createServiceRoleClient();

  const { data: pat, error: patErr } = await svc
    .from("personal_access_tokens")
    .select("id, tenant_id, user_id, scopes, revoked_at, last_used_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (patErr) {
    throw new Error(`assertPermission: PAT lookup failed: ${patErr.message}`);
  }
  if (!pat) {
    throw new Error("assertPermission: invalid personal access token.");
  }
  const patRow = pat as PatRow;
  if (patRow.revoked_at) {
    throw new Error("assertPermission: personal access token has been revoked.");
  }
  // Two-layer tenant isolation: token row's tenant_id vs middleware-resolved tenant.
  if (patRow.tenant_id !== tenantId) {
    throw new Error("assertPermission: personal access token tenant mismatch.");
  }

  // Load acting user — reject unless active in the resolved tenant.
  const { data: userRow, error: userErr } = await svc
    .from("users")
    .select("id, auth_user_id, tenant_id, status, role")
    .eq("id", patRow.user_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (userErr) {
    throw new Error(`assertPermission: PAT user lookup failed: ${userErr.message}`);
  }
  if (!userRow || (userRow as { status: string }).status !== "active") {
    throw new Error("assertPermission: PAT acting user is not active.");
  }
  const actingUser = userRow as User;

  // Scope ceiling: the token's scopes must include this resource:action.
  const scopeKey = `${opts.resource}:${opts.action}`;
  if (!patRow.scopes.includes(scopeKey)) {
    throw new AuthForbidden(opts.resource, opts.action, actingUser.role);
  }

  // Role RBAC — acting user's role must also grant this operation.
  if (!isPermitted(actingUser.role, opts.resource, opts.action)) {
    throw new AuthForbidden(opts.resource, opts.action, actingUser.role);
  }

  // Consent gate — same as JWT bearer path.
  const consentPending = await getConsentPending(actingUser.auth_user_id);
  if (consentPending.length > 0) {
    throw new ConsentPendingError(pathname, consentPending);
  }

  // Throttled last_used_at update: at most one write per PAT_LAST_USED_THROTTLE_MS.
  const lastUsed = patRow.last_used_at ? new Date(patRow.last_used_at).getTime() : 0;
  if (Date.now() - lastUsed > PAT_LAST_USED_THROTTLE_MS) {
    await safeAwait(
      svc
        .from("personal_access_tokens")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", patRow.id),
      "personal_access_tokens.update.last_used_at",
    );
  }

  const ctx: TenantContext = {
    tenant_id: tenantId,
    source: { kind: "http_request", user_id: actingUser.auth_user_id },
  };

  return { ctx, user: actingUser };
}

/**
 * Reads the authentication timestamp (Unix seconds) from a Supabase JWT.
 * Supabase GoTrue does not emit `auth_time`; the equivalent is the most
 * recent `amr[].timestamp` entry. We check `auth_time` first for forward
 * compatibility with custom auth hooks that may set it explicitly.
 * Returns null if neither is present or the JWT is malformed.
 * We do NOT verify the signature — Supabase auth already did in getUser().
 */
export function readAuthTime(jwt: string): number | null {
  try {
    const payload = decodeJwt(jwt) as Record<string, unknown>;

    const auth_time = payload.auth_time;
    if (typeof auth_time === "number" && Number.isFinite(auth_time)) {
      return auth_time;
    }

    // Supabase uses amr[].timestamp — take the most recent entry.
    const amr = payload.amr;
    if (Array.isArray(amr) && amr.length > 0) {
      let latest = 0;
      for (const entry of amr) {
        if (entry && typeof entry === "object") {
          const ts = (entry as Record<string, unknown>).timestamp;
          if (typeof ts === "number" && ts > latest) latest = ts;
        }
      }
      if (latest > 0) return latest;
    }

    return null;
  } catch {
    return null;
  }
}
