/**
 * Cross-tenant fixture setup — §4.1.3 / issue #708
 *
 * Creates two isolated tenants (A and B), each with one user, and seeds
 * a conversation and a booking owned by each tenant.
 *
 * Idempotent: safe to call multiple times; existing rows are reused via upsert.
 * Deterministic UUIDs ensure re-runs never accumulate orphan fixtures.
 *
 * Requirements:
 *   supabaseUrl    → test Supabase project REST endpoint (NEXT_PUBLIC_SUPABASE_URL)
 *   serviceRoleKey → service role key for that project (SUPABASE_SERVICE_ROLE_KEY)
 *
 * The returned sessionToken is a real GoTrue JWT obtained by signing in as each
 * test user. The probe sends this token in Authorization headers to the deployed
 * app (APP_BASE_URL), not to Supabase directly.
 */

import { createClient } from "@supabase/supabase-js";

export interface TenantFixture {
  tenantId: string;
  userId: string;
  /** JWT session token for this user */
  sessionToken: string;
  /** Resource IDs owned by this tenant, keyed by route paramName ("id") */
  resourceIds: Record<string, string>;
}

export interface CrossTenantFixtures {
  tenantA: TenantFixture;
  tenantB: TenantFixture;
}

// Deterministic UUIDs so idempotent upserts work across runs.
const TENANT_A_ID = "aaaa0000-0000-0000-0000-000000000001";
const TENANT_B_ID = "bbbb0000-0000-0000-0000-000000000001";
const USER_A_PUB_ID = "aaaa0000-0000-0000-0001-000000000001";
const USER_B_PUB_ID = "bbbb0000-0000-0000-0001-000000000001";
const BOOKING_A_ID = "aaaa0000-0000-0000-0002-000000000001";
const BOOKING_B_ID = "bbbb0000-0000-0000-0002-000000000001";
const CONV_A_ID = "aaaa0000-0000-0000-0003-000000000001";
const CONV_B_ID = "bbbb0000-0000-0000-0003-000000000001";
const CONTACT_A_ID = "aaaa0000-0000-0000-0004-000000000001";
const CONTACT_B_ID = "bbbb0000-0000-0000-0004-000000000001";

interface FixtureSpec {
  tenantId: string;
  userPubId: string;
  bookingId: string;
  convId: string;
  contactId: string;
  email: string;
  password: string;
  slug: string;
  displayName: string;
}

const SPECS: [FixtureSpec, FixtureSpec] = [
  {
    tenantId: TENANT_A_ID,
    userPubId: USER_A_PUB_ID,
    bookingId: BOOKING_A_ID,
    convId: CONV_A_ID,
    contactId: CONTACT_A_ID,
    email: "probe-a@cross-tenant-test.internal",
    password: "CtProbeA-2024-xk9!",
    slug: "cross-tenant-probe-a",
    displayName: "Cross-Tenant Probe A",
  },
  {
    tenantId: TENANT_B_ID,
    userPubId: USER_B_PUB_ID,
    bookingId: BOOKING_B_ID,
    convId: CONV_B_ID,
    contactId: CONTACT_B_ID,
    email: "probe-b@cross-tenant-test.internal",
    password: "CtProbeB-2024-xk9!",
    slug: "cross-tenant-probe-b",
    displayName: "Cross-Tenant Probe B",
  },
];

async function ensureAuthUser(
  supabase: ReturnType<typeof createClient>,
  email: string,
  password: string,
): Promise<string> {
  const { data: list } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const existing = (list?.users ?? []).find((u) => u.email === email);

  if (existing) {
    // Reset password so sign-in always works regardless of prior state.
    const { error } = await supabase.auth.admin.updateUserById(existing.id, { password });
    if (error) throw new Error(`auth.admin.updateUserById failed for ${email}: ${error.message}`);
    return existing.id;
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`auth.admin.createUser failed for ${email}: ${error?.message ?? "no user returned"}`);
  }
  return data.user.id;
}

async function seedTenant(
  supabase: ReturnType<typeof createClient>,
  spec: FixtureSpec,
  authUserId: string,
  now: string,
): Promise<void> {
  // Tenant — status must be 'active' for tenant_is_active() RLS helper.
  const { error: tErr } = await supabase.from("tenants").upsert(
    {
      id: spec.tenantId,
      slug: spec.slug,
      display_name: spec.displayName,
      tenant_type: "byo_host",
      status: "active",
      ai_mode: "autonomous",
    },
    { onConflict: "id" },
  );
  if (tErr) throw new Error(`tenants.upsert failed (${spec.slug}): ${tErr.message}`);

  // public.users tied to this tenant.
  const { error: uErr } = await supabase.from("users").upsert(
    {
      id: spec.userPubId,
      auth_user_id: authUserId,
      tenant_id: spec.tenantId,
      email: spec.email,
      first_name: "Probe",
      last_name: spec.displayName.split(" ").pop()!,
      status: "active",
      role: "tenant_owner",
    },
    { onConflict: "id" },
  );
  if (uErr) throw new Error(`users.upsert failed (${spec.slug}): ${uErr.message}`);

  // Contact — available as a relatable resource for quote routes.
  const { error: cErr } = await supabase.from("contacts").upsert(
    {
      id: spec.contactId,
      tenant_id: spec.tenantId,
      first_name: "Test",
      last_name: "Contact",
      email: `contact-${spec.slug}@cross-tenant-test.internal`,
    },
    { onConflict: "id" },
  );
  if (cErr) throw new Error(`contacts.upsert failed (${spec.slug}): ${cErr.message}`);

  // Booking — minimal draft record; no cruise details needed for the probe.
  const { error: bErr } = await supabase.from("bookings").upsert(
    {
      id: spec.bookingId,
      tenant_id: spec.tenantId,
      user_id: spec.userPubId,
      primary_contact_id: spec.contactId,
      status: "draft",
      created_at: now,
    },
    { onConflict: "id" },
  );
  if (bErr) throw new Error(`bookings.upsert failed (${spec.slug}): ${bErr.message}`);

  // Conversation — staff-audience chat thread.
  const { error: cvErr } = await supabase.from("conversations").upsert(
    {
      id: spec.convId,
      tenant_id: spec.tenantId,
      user_id: spec.userPubId,
      audience: "tenant_member",
      status: "active",
      message_count: 0,
      first_message_at: now,
      last_message_at: now,
    },
    { onConflict: "id" },
  );
  if (cvErr) throw new Error(`conversations.upsert failed (${spec.slug}): ${cvErr.message}`);
}

export async function setupCrossTenantFixtures(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<CrossTenantFixtures> {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("setupCrossTenantFixtures: supabaseUrl and serviceRoleKey are required");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const now = new Date().toISOString();

  const [authAId, authBId] = await Promise.all([
    ensureAuthUser(supabase, SPECS[0].email, SPECS[0].password),
    ensureAuthUser(supabase, SPECS[1].email, SPECS[1].password),
  ]);

  // Run tenant seeds serially — avoids FK race if auth.users propagation is async.
  await seedTenant(supabase, SPECS[0], authAId, now);
  await seedTenant(supabase, SPECS[1], authBId, now);

  // Sign in as each user to obtain real GoTrue JWTs for the probe.
  // Using the service-role client here is fine: signInWithPassword routes to
  // GoTrue /auth/v1/token and returns a standard user JWT — not a service role token.
  const [sessionA, sessionB] = await Promise.all([
    supabase.auth.signInWithPassword({ email: SPECS[0].email, password: SPECS[0].password }),
    supabase.auth.signInWithPassword({ email: SPECS[1].email, password: SPECS[1].password }),
  ]);

  if (sessionA.error || !sessionA.data.session) {
    throw new Error(`signIn failed for probe-a: ${sessionA.error?.message ?? "no session"}`);
  }
  if (sessionB.error || !sessionB.data.session) {
    throw new Error(`signIn failed for probe-b: ${sessionB.error?.message ?? "no session"}`);
  }

  return {
    tenantA: {
      tenantId: TENANT_A_ID,
      userId: USER_A_PUB_ID,
      sessionToken: sessionA.data.session.access_token,
      // All dynamic API routes use [id] as the paramName. The booking ID is used as
      // the generic resource ID. Routes expecting a different resource type (conversation,
      // quote) will get 404 — acceptable to the probe (only 2xx/5xx are failures).
      resourceIds: { id: BOOKING_A_ID },
    },
    tenantB: {
      tenantId: TENANT_B_ID,
      userId: USER_B_PUB_ID,
      sessionToken: sessionB.data.session.access_token,
      resourceIds: { id: BOOKING_B_ID },
    },
  };
}
