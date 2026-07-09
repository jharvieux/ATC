// §15 / §7.1 — Disposable test-tenant provisioning for the onboarding-funnel
// live harness (#1724, follow-up to #1159).
//
// Steps 1-3 of the funnel need a BRAND-NEW tenant on a FRESH subdomain that no
// prior run has touched — the #1131/#1132/#1133 Stripe return-URL host bug and
// the #1134 first-login 500 only reproduce on a genuinely first-time tenant.
// global-setup.ts injects a session for a PRE-EXISTING owner; it cannot create
// a new tenant. This module does, via the service-role key, and tears the
// tenant back down after the run so the target env doesn't accumulate fixtures.
//
// GATING: provisioning needs SUPABASE_SERVICE_ROLE_KEY (admin auth + writes),
// NEXT_PUBLIC_SUPABASE_URL/ANON_KEY, and TEST_E2E_TENANT_APEX (the wildcard apex
// under which a fresh slug resolves to a subdomain — e.g. "ai-travelconcierge.com",
// so slug "e2e-funnel-x" is reachable at e2e-funnel-x.ai-travelconcierge.com).
// The apex is explicit rather than derived from BASE_URL because the live
// subdomain topology (whether staging tenants live under the apex or under a
// staging.* label) is env-specific and must not be guessed. Absent any of
// these, provisionEnabled() is false and the caller SKIPS LOUDLY — the harness
// never provisions against an unknown target.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const TENANT_APEX = process.env.TEST_E2E_TENANT_APEX ?? "";
const BASE_URL = process.env.BASE_URL ?? "";
const IS_REAL_DEPLOYMENT = BASE_URL !== "" && !/localhost|127\.0\.0\.1/.test(BASE_URL);

export function provisionEnabled(): boolean {
  return Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ANON_KEY && TENANT_APEX && IS_REAL_DEPLOYMENT);
}

export const PROVISION_SKIP_REASON =
  "onboarding-funnel provisioning: requires SUPABASE_SERVICE_ROLE_KEY, " +
  "NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, TEST_E2E_TENANT_APEX " +
  "(the wildcard apex for fresh tenant subdomains), and a real BASE_URL. These " +
  "GitHub secrets are tracked in #1286 and not yet provisioned. Skipping cleanly.";

export interface ProvisionedTenant {
  tenantId: string;
  slug: string;
  /** Host the fresh tenant resolves at, e.g. "e2e-funnel-....ai-travelconcierge.com". */
  host: string;
  /** Full origin, e.g. "https://e2e-funnel-....ai-travelconcierge.com". */
  origin: string;
  ownerEmail: string;
  ownerPassword: string;
  authUserId: string;
  publicUserId: string;
}

// A distinct slug per run so every provisioned tenant is a genuinely fresh
// subdomain (the regressions under test only surface on first-time tenants).
function freshSlug(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `e2e-funnel-${Date.now().toString(36)}-${rand}`;
}

function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function provisionTestTenant(): Promise<ProvisionedTenant> {
  if (!provisionEnabled()) {
    throw new Error(`provisionTestTenant called while disabled — ${PROVISION_SKIP_REASON}`);
  }

  const supabase = adminClient();
  const slug = freshSlug();
  const ownerEmail = `${slug}@e2e-funnel.internal`;
  const ownerPassword = `Fn-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}!`;

  // Cheapest tier so the tenants.tier_id FK is satisfied without hardcoding a
  // migration-generated UUID (mirrors scripts/seed-tier2-test.ts).
  const { data: tier, error: tierErr } = await supabase
    .from("tier_definitions")
    .select("id")
    .eq("code", "byo_research")
    .limit(1)
    .single();
  if (tierErr || !tier) {
    throw new Error(`provisionTestTenant: byo_research tier lookup failed: ${tierErr?.message ?? "no row"}`);
  }

  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email: ownerEmail,
    password: ownerPassword,
    email_confirm: true,
  });
  if (createErr || !created?.user) {
    throw new Error(`provisionTestTenant: auth.admin.createUser failed: ${createErr?.message ?? "no user"}`);
  }
  const authUserId = created.user.id;

  const { data: tenant, error: tErr } = await supabase
    .from("tenants")
    .insert({
      slug,
      display_name: `E2E Funnel ${slug}`,
      legal_name: `E2E Funnel ${slug} LLC`,
      tenant_type: "byo_host",
      status: "active",
      tier_id: tier.id,
      seat_count: 1,
      billing_period: "monthly",
      ai_mode: "autonomous",
    })
    .select("id")
    .single();
  if (tErr || !tenant) {
    // Roll back the auth user so a failed run leaves nothing behind.
    await supabase.auth.admin.deleteUser(authUserId).catch(() => undefined);
    throw new Error(`provisionTestTenant: tenants.insert failed: ${tErr?.message ?? "no row"}`);
  }
  const tenantId = tenant.id as string;

  const { data: pubUser, error: uErr } = await supabase
    .from("users")
    .insert({
      auth_user_id: authUserId,
      tenant_id: tenantId,
      email: ownerEmail,
      first_name: "Funnel",
      last_name: "Owner",
      status: "active",
      role: "tenant_owner",
    })
    .select("id")
    .single();
  if (uErr || !pubUser) {
    await teardownTestTenant({ tenantId, authUserId }).catch(() => undefined);
    throw new Error(`provisionTestTenant: users.insert failed: ${uErr?.message ?? "no row"}`);
  }

  const host = `${slug}.${TENANT_APEX}`;
  return {
    tenantId,
    slug,
    host,
    origin: `https://${host}`,
    ownerEmail,
    ownerPassword,
    authUserId,
    publicUserId: pubUser.id as string,
  };
}

// Removes everything provisionTestTenant created. Children (public.users) go
// before the tenant row; the auth user goes last. A stray Stripe test-mode
// Connect account created by step 3 is left in place — it's a disposable
// test-mode object and the harness holds no STRIPE_SECRET_KEY to delete it.
export async function teardownTestTenant(t: Pick<ProvisionedTenant, "tenantId" | "authUserId">): Promise<void> {
  if (!provisionEnabled()) return;
  const supabase = adminClient();

  if (t.tenantId) {
    const { error: uErr } = await supabase.from("users").delete().eq("tenant_id", t.tenantId);
    if (uErr) throw new Error(`teardownTestTenant: users.delete failed: ${uErr.message}`);
    const { error: tErr } = await supabase.from("tenants").delete().eq("id", t.tenantId);
    if (tErr) throw new Error(`teardownTestTenant: tenants.delete failed: ${tErr.message}`);
  }
  if (t.authUserId) {
    const { error } = await supabase.auth.admin.deleteUser(t.authUserId);
    if (error) throw new Error(`teardownTestTenant: auth.admin.deleteUser failed: ${error.message}`);
  }
}

// Confirms the tenant row exists — the step-1 assertion that a "sign-up"
// produced a real tenant record. Reads via service role so it sees the row
// regardless of RLS.
export async function tenantRecordExists(tenantId: string): Promise<boolean> {
  const supabase = adminClient();
  const { data, error } = await supabase.from("tenants").select("id, status").eq("id", tenantId).single();
  if (error) return false;
  return data?.id === tenantId && data?.status === "active";
}

// GoTrue password grant for the provisioned owner → session JSON, injected as
// the sb-<ref>-auth-token cookie (same shape as global-setup.ts) so SSR
// getCachedUser() authenticates the fresh owner on the tenant host.
export async function ownerSessionCookie(
  t: Pick<ProvisionedTenant, "ownerEmail" | "ownerPassword" | "host">,
): Promise<{
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax";
}> {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email: t.ownerEmail, password: t.ownerPassword }),
  });
  if (!resp.ok) {
    throw new Error(`ownerSessionCookie: GoTrue sign-in failed (${resp.status}): ${await resp.text()}`);
  }
  const session: unknown = await resp.json();
  const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0]!;
  return {
    name: `sb-${projectRef}-auth-token`,
    value: JSON.stringify(session),
    domain: t.host,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  };
}
