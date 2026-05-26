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

import { createClient } from "@supabase/supabase-js";
import { tenantContextFromRequest } from "@/lib/db/factories";
import type { TenantContext } from "@/lib/db/tenant-context";
import {
  isSensitiveRoute,
  SENSITIVE_SESSION_MAX_AGE_MS,
} from "./sensitive-routes";
import { tryTestBypass } from "./test-bypass";
import { isPermitted, type UserRole } from "./permission-grants";
import { getConsentPending, type PendingConsent } from "@/lib/consent/pending";

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
 * /consent + /logout + /legal/* must be redirected to /consent. In this
 * codebase the auth token isn't in cookies (it's in localStorage and
 * passed via Authorization headers), so middleware can't see who's
 * authenticated — the gate enforces here instead, where we already
 * verified the bearer and know the auth_user_id.
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

  const ctx = await tenantContextFromRequest(req);

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("assertPermission: missing Authorization Bearer token.");
  }
  const accessToken = authHeader.slice("Bearer ".length);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const supabase = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  const { data: authData, error: authErr } = await supabase.auth.getUser();
  if (authErr || !authData?.user) {
    throw new Error("assertPermission: invalid or expired access token.");
  }

  const pathname = new URL(req.url).pathname;

  // §17.4 Versioned consent gate. If the caller has pending user_consent_pending
  // rows (new document version published since their last acceptance), block
  // every authenticated action other than the consent acceptance flow itself.
  // The /api/user/consent and /api/user/consent/pending routes don't go
  // through assertPermission, so this doesn't deadlock the user out of
  // accepting; downstream they'll catch ConsentPendingError, return 403 with
  // `consent_pending` + return_to, and the client routes to /consent.
  const pending = await getConsentPending(authData.user.id);
  if (pending.length > 0) {
    throw new ConsentPendingError(pathname, pending);
  }

  // §26.3 sensitive-action re-auth check. Decode auth_time from the JWT
  // payload (no signature verification needed — Supabase already validated
  // the token in getUser()). If stale, throw the structured error.
  if (isSensitiveRoute(pathname)) {
    const authTime = readAuthTime(accessToken);
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
    .eq("auth_user_id", authData.user.id)
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

/**
 * Reads the JWT `auth_time` claim (Unix seconds). Returns null if the
 * claim is missing or the JWT is malformed. We do NOT verify the signature
 * here — Supabase auth already did in getUser().
 */
function readAuthTime(jwt: string): number | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    const auth_time = payload.auth_time;
    return typeof auth_time === "number" && Number.isFinite(auth_time)
      ? auth_time
      : null;
  } catch {
    return null;
  }
}
