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

/** PostgREST returns embedded foreign-table joins as either a single
 *  object OR an array depending on how the FK is resolved — even for
 *  what we KNOW is a 1:1 relationship. The sibling fetch-tenant-branding.ts
 *  helper hit the same issue and handles both shapes; the dispatcher must
 *  too (#665). `normalizeTenant` collapses both into the object shape. */
type EmbeddedTenant = {
  onboarding_stage: OnboardingStage | null;
  /** Tenant lifecycle status. DB CHECK constraint: one of `onboarding`,
   *  `pending_review`, `active`, `suspended`, `terminated`. The
   *  dispatcher filters out `suspended` and `terminated` so a user under
   *  a deactivated tenant doesn't get routed to /crm and 403'd by
   *  assertPermission (#666). `onboarding` and `pending_review` are
   *  ALLOWED — they're normal mid-funnel states, routed via the
   *  onboarding-stage URL map. */
  status: string;
};

/** Tenant statuses that route normally (onboarding flow + crm). Other
 *  statuses (`suspended`, `terminated`) drop the membership row from the
 *  picker — the user falls through to /chat. */
const ROUTEABLE_TENANT_STATUSES: ReadonlySet<string> = new Set([
  "onboarding",
  "pending_review",
  "active",
]);

export function isRouteableTenant(t: EmbeddedTenant | null): boolean {
  return t !== null && ROUTEABLE_TENANT_STATUSES.has(t.status);
}

export type MembershipRow = {
  role: string;
  tenant_id: string;
  tenants: EmbeddedTenant | EmbeddedTenant[] | null;
};

export function normalizeTenant(t: MembershipRow["tenants"]): EmbeddedTenant | null {
  if (t === null) return null;
  return Array.isArray(t) ? t[0] ?? null : t;
}

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

// #962 — role for ONE specific tenant (the one the middleware resolved
// from the subdomain), for the landing shell's nav gating. Unlike the
// dispatcher below, which picks across ALL memberships, this pins
// tenant_id — the verified auth_user_id plus the explicit tenant_id
// filter are the two scoping layers on the service-role query (D-091).
// Returns null when the user has no active membership in a routeable
// tenant (#666 filter); callers fall back to the redirect dispatch.
export async function getTenantRole(
  authUserId: string,
  tenantId: string,
): Promise<PostLoginRole | null> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("users")
    .select("role, tenant_id, tenants(onboarding_stage, status)")
    .eq("auth_user_id", authUserId)
    .eq("tenant_id", tenantId)
    .eq("status", "active");
  if (error) {
    throw new Error(`getTenantRole: users lookup: ${error.message}`);
  }
  const rows = ((data ?? []) as unknown as MembershipRow[]).filter((r) =>
    isRouteableTenant(normalizeTenant(r.tenants)),
  );
  return pickHighestRankActiveMembership(rows)?.role ?? null;
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
    .select("role, tenant_id, status, tenants(onboarding_stage, status)")
    .eq("auth_user_id", authUserId)
    .eq("status", "active");
  if (rowsErr) {
    throw new Error(`resolvePostLoginDestination: users lookup: ${rowsErr.message}`);
  }

  // Filter out memberships whose embedded tenant is non-routeable
  // (`suspended` / `terminated`). A still-active user under a
  // deactivated tenant must not be routed to /crm where assertPermission
  // will 403. Falls through to viewer/chat (#666).
  const rowsWithRouteableTenant = ((rows ?? []) as unknown as MembershipRow[]).filter(
    (r) => isRouteableTenant(normalizeTenant(r.tenants)),
  );

  const picked = pickHighestRankActiveMembership(rowsWithRouteableTenant);

  // No active row with a known role — could be: callback skipped the
  // membership upsert (legacy: PLATFORM_DEFAULT_TENANT_ID unset, see
  // #441), or every row has an unknown role from a future enum value.
  // Either way the safest landing is the customer chat surface.
  if (picked === null) {
    return postLoginDestination({ isPlatformAdmin: false, role: "viewer" });
  }

  const tenant = normalizeTenant(picked.tenants);
  return postLoginDestination({
    isPlatformAdmin: false,
    role: picked.role,
    tenantOnboardingStage: tenant?.onboarding_stage ?? null,
  });
}
