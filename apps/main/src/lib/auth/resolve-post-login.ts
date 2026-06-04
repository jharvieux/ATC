// Request-aware adapter that gathers the inputs `postLoginDestination`
// needs and returns the URL path a logged-in user should land on.
//
// Returns `null` if the request has no valid session — the caller should
// then render the public landing instead of redirecting. Never throws on
// "missing session" or "user not yet provisioned"; throws only on
// unexpected DB errors, which surfaces as a 500 (better than silently
// sending the user somewhere wrong).

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { createRequestScopedClient } from "@/lib/auth/ssr-client";
import { type OnboardingStage } from "@/lib/onboarding/state-machine";
import {
  postLoginDestination,
  type PostLoginRole,
} from "@/lib/auth/post-login-destination";

/** Shape of one row returned by the user-membership query. Exported so
 *  pickHighestRankActiveMembership can be unit-tested without spinning
 *  up the DB adapter. */
export type MembershipRow = {
  role: string;
  tenant_id: string;
  tenants: { onboarding_stage: OnboardingStage | null } | null;
};

const ROLE_RANK: Record<PostLoginRole, number> = {
  tenant_owner: 3,
  agent: 2,
  viewer: 1,
};

function isKnownRole(role: string): role is PostLoginRole {
  return role in ROLE_RANK;
}

/**
 * From the set of active membership rows for one user, pick the one whose
 * role has the highest rank (tenant_owner > agent > viewer). Rows whose
 * role isn't in the known enum are dropped — this protects against a
 * future SQL enum addition that the app code hasn't caught up to (the
 * naive reducer would silently keep the first row because
 * `ROLE_RANK[unknown] === undefined` and `undefined > undefined === false`).
 *
 * Returns `null` if no rows have a known role.
 *
 * Pure — no DB access. The DB adapter (resolvePostLoginDestination) calls
 * this on the raw query result.
 */
export function pickHighestRankActiveMembership(
  rows: MembershipRow[],
): (Omit<MembershipRow, "role"> & { role: PostLoginRole }) | null {
  const known = rows.filter(
    (r): r is Omit<MembershipRow, "role"> & { role: PostLoginRole } =>
      isKnownRole(r.role),
  );
  if (known.length === 0) return null;
  return known.reduce((best, row) =>
    ROLE_RANK[row.role] > ROLE_RANK[best.role] ? row : best,
  );
}

export async function resolvePostLoginDestination(
  req: Request,
): Promise<string | null> {
  // Read the session first. Anonymous → no destination, caller renders
  // the landing. `createRequestScopedClient` throws on missing env vars
  // — we deliberately do NOT catch that here, matching the fail-loud
  // pattern in `assert-platform-admin.ts`. Silent fallback on server
  // misconfig would route every logged-in user to the public landing
  // and look like a benign UX bug instead of a 500.
  const supabase = createRequestScopedClient(req);
  const { data: authData, error: authErr } = await supabase.auth.getUser();
  if (authErr || !authData?.user) return null;
  const authUserId = authData.user.id;

  const db = createServiceRoleClient();

  // Platform-admin check first — short-circuit before any tenant lookup.
  // Use maybeSingle so "not an admin" is a null row, not an error.
  const { data: adminRow, error: adminErr } = await db
    .from("platform_admins")
    .select("auth_user_id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (adminErr) {
    throw new Error(`resolvePostLoginDestination: platform_admins lookup: ${adminErr.message}`);
  }
  if (adminRow !== null) {
    return postLoginDestination({ isPlatformAdmin: true });
  }

  // Fetch the user's tenant membership row + the tenant's onboarding
  // stage in a single round trip via foreign-table select. There may be
  // multiple membership rows if a user belongs to several tenants
  // (cross-tenant admin tools); pickHighestRankActiveMembership picks
  // the most-privileged active row so the dispatch matches the user's
  // working context.
  const { data: rows, error: rowsErr } = await db
    .from("users")
    .select("role, tenant_id, status, tenants(onboarding_stage)")
    .eq("auth_user_id", authUserId)
    .eq("status", "active");
  if (rowsErr) {
    throw new Error(`resolvePostLoginDestination: users lookup: ${rowsErr.message}`);
  }

  const picked = pickHighestRankActiveMembership(
    (rows ?? []) as unknown as MembershipRow[],
  );

  // No active row with a known role — could be: callback skipped the
  // membership upsert (legacy: PLATFORM_DEFAULT_TENANT_ID unset, see
  // #441), or every row has an unknown role from a future enum value.
  // Either way the safest landing is the customer chat surface.
  if (picked === null) {
    return postLoginDestination({ isPlatformAdmin: false, role: "viewer" });
  }

  return postLoginDestination({
    isPlatformAdmin: false,
    role: picked.role,
    tenantOnboardingStage: picked.tenants?.onboarding_stage ?? null,
  });
}
