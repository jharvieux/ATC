// Spec ref: §7.9 / §26.3 (assertPermission canonical contract)
//
// assertPermission verifies that the caller is an authenticated, active member
// of the resolved tenant. For sensitive routes (§17.7 / §26.3 re-auth list)
// it also asserts the JWT's `auth_time` claim is ≤ 4 hours old; on a stale
// auth_time it throws AuthReauthRequired with a structured shape so the
// client can redirect to /auth/reauth?return=...
//
// Full RBAC matrix is later spec work; for now we log resource+action and
// proceed once membership + freshness pass.

import { createClient } from "@supabase/supabase-js";
import { tenantContextFromRequest } from "@/lib/db/factories";
import type { TenantContext } from "@/lib/db/tenant-context";
import {
  isSensitiveRoute,
  SENSITIVE_SESSION_MAX_AGE_MS,
} from "./sensitive-routes";
import { tryTestBypass } from "./test-bypass";

export type User = {
  id: string;
  auth_user_id: string;
  tenant_id: string;
  status: string;
};

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

interface AssertPermissionOpts {
  resource: string;
  action: string;
}

export async function assertPermission(
  req: Request,
  opts: AssertPermissionOpts,
): Promise<{ ctx: TenantContext; user: User }> {
  // TODO(rbac): evaluate against the permission matrix when §26.2 RBAC lands.
  console.log("[assertPermission] resource=%s action=%s", opts.resource, opts.action);

  // Tier-2 E2E auth bypass — only fires when NODE_ENV !== production AND
  // TEST_AUTH_BYPASS_TOKEN is set AND the request carries the matching
  // Bearer. Skips both the GoTrue call AND the post-bypass users-row
  // lookup (the lookup would need PostgREST in front of local Postgres,
  // which Tier-2 deliberately avoids — the seed script is the source of
  // truth that the user exists; tests that need richer user state should
  // assert it themselves). See lib/auth/test-bypass.ts.
  const bypass = tryTestBypass(req);
  if (bypass) {
    const ctxBypass = await tenantContextFromRequest(req);
    const syntheticUser: User = {
      id: process.env.TEST_AUTH_BYPASS_PUBLIC_USER_ID ?? bypass.auth_user_id,
      auth_user_id: bypass.auth_user_id,
      tenant_id: bypass.tenant_id,
      status: "active",
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

  // §26.3 sensitive-action re-auth check. Decode auth_time from the JWT
  // payload (no signature verification needed — Supabase already validated
  // the token in getUser()). If stale, throw the structured error.
  const pathname = new URL(req.url).pathname;
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
    .select("id, auth_user_id, tenant_id, status")
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

  return { ctx, user: row as User };
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
