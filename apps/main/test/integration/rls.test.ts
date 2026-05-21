// RLS integration tests
// Spec refs: §5.1 (tenants, users), §5.1.X (hard-delete), §5.1.2 (policy coverage)
//
// Validates tenant-isolation invariants against the live Supabase project:
//   1. Cross-tenant SELECT is denied by RLS.
//   2. A user in a suspended tenant can SELECT but cannot INSERT.
//   3. Hard-DELETE on a tenant raises without the override.
//   4. Hard-DELETE with `SET LOCAL app.allow_tenant_hard_delete = 'true'`
//      override succeeds.
//
// Each suite creates random-prefixed ephemeral tenants/users via service
// role, then exercises authenticated-client behavior. afterAll tears
// everything down so repeated runs don't accumulate fixtures.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_URL = process.env.SUPABASE_DB_URL;

const haveSupabase = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_KEY && DB_URL);

const describeIf = haveSupabase ? describe : describe.skip;

// Random prefix scopes all fixtures to this test run; afterAll uses it to
// clean up even if intermediate assertions fail.
const RUN_TAG = `rlstest-${randomUUID().slice(0, 8)}`;

const slug = (suffix: string) => `${RUN_TAG}-${suffix}`;
const email = (suffix: string) => `${RUN_TAG}-${suffix}@example.test`;

interface Fixtures {
  admin: SupabaseClient;
  sql: ReturnType<typeof postgres>;
  tenantA: { id: string; slug: string };
  tenantB: { id: string; slug: string };
  tenantSuspended: { id: string; slug: string };
  userA: { authId: string; rowId: string; email: string; password: string };
  userB: { authId: string; rowId: string; email: string; password: string };
  userSuspended: { authId: string; rowId: string; email: string; password: string };
}

let fx: Fixtures;

async function authedClient(
  emailAddr: string,
  password: string,
): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL!, ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: emailAddr,
    password,
  });
  if (error || !data.session) {
    throw new Error(`Sign-in failed for ${emailAddr}: ${error?.message}`);
  }
  return client;
}

describeIf("RLS integration", () => {
  beforeAll(async () => {
    const admin = createClient(SUPABASE_URL!, SERVICE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const sql = postgres(DB_URL!, { max: 1, idle_timeout: 10, onnotice: () => {} });

    // Tier id for fixture tenants — pick the seeded byo_research row.
    const tier = await sql<{ id: string }[]>`
      SELECT id FROM public.tier_definitions WHERE code = 'byo_research' LIMIT 1
    `;
    if (tier.length === 0 || !tier[0]) {
      throw new Error("tier_definitions not seeded — apply migrations first");
    }
    const tierId = tier[0].id;

    const mkTenant = async (
      suffix: string,
      status: "active" | "suspended",
    ): Promise<{ id: string; slug: string }> => {
      const tSlug = slug(suffix);
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO public.tenants (
          slug, display_name, legal_name, tenant_type, status, tier_id
        ) VALUES (
          ${tSlug}, ${`Test ${suffix}`}, ${`Test ${suffix} LLC`},
          'byo_host', ${status}, ${tierId}
        )
        RETURNING id
      `;
      if (!row) throw new Error("tenant insert returned no row");
      return { id: row.id, slug: tSlug };
    };

    const mkUser = async (
      suffix: string,
      tenantId: string,
    ): Promise<{
      authId: string;
      rowId: string;
      email: string;
      password: string;
    }> => {
      const e = email(suffix);
      const password = `Pw-${randomUUID()}`;
      const created = await admin.auth.admin.createUser({
        email: e,
        password,
        email_confirm: true,
      });
      if (created.error || !created.data.user) {
        throw new Error(`createUser failed: ${created.error?.message}`);
      }
      const authId = created.data.user.id;
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO public.users (auth_user_id, tenant_id, email, status)
        VALUES (${authId}, ${tenantId}, ${e}, 'active')
        RETURNING id
      `;
      if (!row) throw new Error("user insert returned no row");
      return { authId, rowId: row.id, email: e, password };
    };

    const tenantA = await mkTenant("a", "active");
    const tenantB = await mkTenant("b", "active");
    const tenantSuspended = await mkTenant("susp", "suspended");

    const userA = await mkUser("a", tenantA.id);
    const userB = await mkUser("b", tenantB.id);
    const userSuspended = await mkUser("susp", tenantSuspended.id);

    fx = {
      admin,
      sql,
      tenantA,
      tenantB,
      tenantSuspended,
      userA,
      userB,
      userSuspended,
    };
  }, 60000);

  afterAll(async () => {
    if (!fx) return;
    const { admin, sql } = fx;
    const allTenants = [fx.tenantA.id, fx.tenantB.id, fx.tenantSuspended.id];
    const allAuthIds = [fx.userA.authId, fx.userB.authId, fx.userSuspended.authId];

    try {
      await sql`DELETE FROM public.users WHERE tenant_id = ANY(${allTenants})`;
      for (const authId of allAuthIds) {
        await admin.auth.admin.deleteUser(authId).catch(() => {});
      }
      await sql.begin(async (tx) => {
        await tx`SET LOCAL app.allow_tenant_hard_delete = 'true'`;
        await tx`DELETE FROM public.tenants WHERE id = ANY(${allTenants})`;
      });
    } finally {
      await sql.end();
    }
  }, 60000);

  it("user in tenant A cannot SELECT rows from tenant B", async () => {
    const clientA = await authedClient(fx.userA.email, fx.userA.password);
    const { data, error } = await clientA
      .from("users")
      .select("id, tenant_id")
      .eq("tenant_id", fx.tenantB.id);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("user in suspended tenant CAN SELECT but CANNOT INSERT", async () => {
    const client = await authedClient(
      fx.userSuspended.email,
      fx.userSuspended.password,
    );

    const sel = await client
      .from("users")
      .select("id")
      .eq("id", fx.userSuspended.rowId);
    expect(sel.error).toBeNull();
    expect(sel.data?.length).toBe(1);

    const ins = await client
      .from("users")
      .insert({
        auth_user_id: fx.userSuspended.authId,
        tenant_id: fx.tenantSuspended.id,
        email: email("susp-blocked"),
        status: "active",
      });
    expect(ins.error).not.toBeNull();
  });

  it("hard-DELETE on a tenant raises without the override", async () => {
    const tmp = `${RUN_TAG}-doomed`;
    const tier = await fx.sql<{ id: string }[]>`
      SELECT id FROM public.tier_definitions WHERE code = 'byo_research' LIMIT 1
    `;
    const tierRow = tier[0];
    if (!tierRow) throw new Error("tier_definitions empty");
    const [t] = await fx.sql<{ id: string }[]>`
      INSERT INTO public.tenants (slug, display_name, legal_name, tenant_type, status, tier_id)
      VALUES (${tmp}, 'Doomed', 'Doomed LLC', 'byo_host', 'active', ${tierRow.id})
      RETURNING id
    `;
    if (!t) throw new Error("tenant insert returned no row");

    let raised = false;
    try {
      await fx.sql`DELETE FROM public.tenants WHERE id = ${t.id}`;
    } catch (err) {
      raised = true;
      expect(String(err)).toMatch(/Hard delete of tenants is not permitted/);
    }
    expect(raised).toBe(true);

    await fx.sql.begin(async (tx) => {
      await tx`SET LOCAL app.allow_tenant_hard_delete = 'true'`;
      await tx`DELETE FROM public.tenants WHERE id = ${t.id}`;
    });
  });

  it("hard-DELETE succeeds with SET LOCAL override", async () => {
    const tmp = `${RUN_TAG}-overridden`;
    const tier = await fx.sql<{ id: string }[]>`
      SELECT id FROM public.tier_definitions WHERE code = 'byo_research' LIMIT 1
    `;
    const tierRow = tier[0];
    if (!tierRow) throw new Error("tier_definitions empty");
    const [t] = await fx.sql<{ id: string }[]>`
      INSERT INTO public.tenants (slug, display_name, legal_name, tenant_type, status, tier_id)
      VALUES (${tmp}, 'Overridden', 'Overridden LLC', 'byo_host', 'active', ${tierRow.id})
      RETURNING id
    `;
    if (!t) throw new Error("tenant insert returned no row");

    await fx.sql.begin(async (tx) => {
      await tx`SET LOCAL app.allow_tenant_hard_delete = 'true'`;
      await tx`DELETE FROM public.tenants WHERE id = ${t.id}`;
    });

    const remaining = await fx.sql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE id = ${t.id}
    `;
    expect(remaining.length).toBe(0);
  });
});
