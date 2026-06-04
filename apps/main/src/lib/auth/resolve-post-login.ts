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
  // (cross-tenant admin tools); we pick the active one with the highest
  // privilege (tenant_owner > agent > viewer) so the dispatch matches the
  // user's working context.
  const { data: rows, error: rowsErr } = await db
    .from("users")
    .select("role, tenant_id, status, tenants(onboarding_stage)")
    .eq("auth_user_id", authUserId)
    .eq("status", "active");
  if (rowsErr) {
    throw new Error(`resolvePostLoginDestination: users lookup: ${rowsErr.message}`);
  }

  // No active tenant membership at all — the auth callback should have
  // upserted a row, but if it didn't (legacy account, callback skipped
  // because PLATFORM_DEFAULT_TENANT_ID was unset), default to the
  // customer experience.
  if (!rows || rows.length === 0) {
    return postLoginDestination({ isPlatformAdmin: false, role: "viewer" });
  }

  const ROLE_RANK: Record<PostLoginRole, number> = {
    tenant_owner: 3,
    agent: 2,
    viewer: 1,
  };
  type Row = {
    role: PostLoginRole;
    tenant_id: string;
    tenants: { onboarding_stage: OnboardingStage | null } | null;
  };
  // Filter to known roles defensively — if a future enum value lands in
  // users.role before app code catches up, the unfiltered cast would let
  // `ROLE_RANK[unknown] === undefined` slip into the reducer and
  // silently keep the first row regardless of rank.
  const known = (rows as unknown as { role: string }[])
    .filter((r): r is Row => r.role in ROLE_RANK)
    .map((r) => r as Row);
  if (known.length === 0) {
    return postLoginDestination({ isPlatformAdmin: false, role: "viewer" });
  }
  const picked = known.reduce((best, row) =>
    ROLE_RANK[row.role] > ROLE_RANK[best.role] ? row : best,
  );

  return postLoginDestination({
    isPlatformAdmin: false,
    role: picked.role,
    tenantOnboardingStage: picked.tenants?.onboarding_stage ?? null,
  });
}
