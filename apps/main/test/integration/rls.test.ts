// RLS integration tests
// Spec refs: §5.1 (tenants, users), §5.1.X (hard-delete), §5.1.2 (policy coverage)
//            §5.2 (conversations, messages), §5.3 (bookings, commissions, subcontractors,
//            payout_balances, payout_records, stripe_webhook_events)
//
// Validates tenant-isolation invariants against the live Supabase project:
//   1. Cross-tenant SELECT is denied by RLS.
//   2. A user in a suspended tenant can SELECT but cannot INSERT.
//   3. Hard-DELETE on a tenant raises without the override.
//   4. Hard-DELETE with `SET LOCAL app.allow_tenant_hard_delete = 'true'`
//      override succeeds.
//   5. BP05 domain tables each enforce cross-tenant isolation.
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

  // ── BP05 domain tables ────────────────────────────────────────────────────
  // One cross-tenant isolation check per new table. Also verifies that
  // suspended-tenant users can SELECT but cannot INSERT on conversations,
  // bookings, and subcontractors.

  describe("BP05 domain tables RLS", () => {
    let convAId: string;
    let convSuspId: string;
    let bookingAId: string;

    beforeAll(async () => {
      if (!fx) return;
      const { sql, tenantA, tenantSuspended } = fx;

      // conversations (tenantA + tenantSuspended for read test)
      const [convA] = await sql<{ id: string }[]>`
        INSERT INTO public.conversations (tenant_id, title, status)
        VALUES (${tenantA.id}, 'RLS test conv A', 'active')
        RETURNING id
      `;
      if (!convA) throw new Error("conv A insert failed");
      convAId = convA.id;

      const [convS] = await sql<{ id: string }[]>`
        INSERT INTO public.conversations (tenant_id, title, status)
        VALUES (${tenantSuspended.id}, 'RLS test conv susp', 'active')
        RETURNING id
      `;
      if (!convS) throw new Error("conv susp insert failed");
      convSuspId = convS.id;

      // messages — seeded under convA (tenantA)
      await sql`
        INSERT INTO public.messages (tenant_id, conversation_id, role, content)
        VALUES (${tenantA.id}, ${convAId}, 'user', 'hello from RLS test')
      `;

      // bookings (tenantA)
      const [bookingA] = await sql<{ id: string }[]>`
        INSERT INTO public.bookings (tenant_id, booking_type, status)
        VALUES (${tenantA.id}, 'cruise', 'draft')
        RETURNING id
      `;
      if (!bookingA) throw new Error("booking A insert failed");
      bookingAId = bookingA.id;

      // commissions (tenantA, references bookingAId)
      await sql`
        INSERT INTO public.commissions (
          tenant_id, booking_id,
          commissionable_fare_cents, commission_rate, platform_split_rate,
          gross_commission_cents, host_booking_fee_cents,
          net_commission_cents, platform_retained_cents, subhost_payable_cents
        ) VALUES (
          ${tenantA.id}, ${bookingAId},
          100000, 0.10, 0.20,
          10000, 0,
          8000, 2000, 8000
        )
      `;

      // subcontractors (tenantA)
      await sql`
        INSERT INTO public.subcontractors (tenant_id, name, payout_percent)
        VALUES (${tenantA.id}, 'RLS Test Sub', 10.00)
      `;

      // payout_balances (one row per tenant, using tenantA)
      await sql`
        INSERT INTO public.payout_balances (tenant_id, hold_period_days)
        VALUES (${tenantA.id}, 7)
        ON CONFLICT (tenant_id) DO NOTHING
      `;

      // payout_records (tenantA)
      await sql`
        INSERT INTO public.payout_records (tenant_id, amount_cents, status)
        VALUES (${tenantA.id}, 5000, 'processing')
      `;

      // stripe_webhook_events — one with tenantA, one platform-level (null)
      await sql`
        INSERT INTO public.stripe_webhook_events
          (stripe_event_id, event_type, endpoint, tenant_id, raw_event)
        VALUES
          (${RUN_TAG + '-evt-tenant'}, 'charge.succeeded', 'connect', ${tenantA.id}, '{}'),
          (${RUN_TAG + '-evt-platform'}, 'account.updated', 'platform', NULL, '{}')
      `;
    }, 30000);

    afterAll(async () => {
      if (!fx) return;
      const { sql, tenantA, tenantSuspended } = fx;
      const tids = [tenantA.id, tenantSuspended.id];
      // Delete in FK-dependency order (most-dependent first).
      await sql`DELETE FROM public.stripe_webhook_events WHERE stripe_event_id LIKE ${RUN_TAG + '%'}`;
      await sql`DELETE FROM public.payout_records WHERE tenant_id = ANY(${tids})`;
      await sql`DELETE FROM public.payout_balances WHERE tenant_id = ANY(${tids})`;
      await sql`DELETE FROM public.subcontractors WHERE tenant_id = ANY(${tids})`;
      await sql`DELETE FROM public.commissions WHERE tenant_id = ANY(${tids})`;
      await sql`DELETE FROM public.bookings WHERE tenant_id = ANY(${tids})`;
      await sql`DELETE FROM public.messages WHERE tenant_id = ANY(${tids})`;
      await sql`DELETE FROM public.conversations WHERE tenant_id = ANY(${tids})`;
    }, 30000);

    it("conversations: userB cannot SELECT tenantA rows", async () => {
      const clientB = await authedClient(fx.userB.email, fx.userB.password);
      const { data, error } = await clientB
        .from("conversations")
        .select("id")
        .eq("tenant_id", fx.tenantA.id);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("conversations: suspended user CAN SELECT but CANNOT INSERT", async () => {
      const client = await authedClient(fx.userSuspended.email, fx.userSuspended.password);
      const sel = await client
        .from("conversations")
        .select("id")
        .eq("id", convSuspId);
      expect(sel.error).toBeNull();
      expect(sel.data?.length).toBe(1);

      const ins = await client
        .from("conversations")
        .insert({ tenant_id: fx.tenantSuspended.id, title: "blocked", status: "active" });
      expect(ins.error).not.toBeNull();
    });

    it("messages: userB cannot SELECT tenantA messages", async () => {
      const clientB = await authedClient(fx.userB.email, fx.userB.password);
      const { data, error } = await clientB
        .from("messages")
        .select("id")
        .eq("tenant_id", fx.tenantA.id);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("bookings: userB cannot SELECT tenantA rows", async () => {
      const clientB = await authedClient(fx.userB.email, fx.userB.password);
      const { data, error } = await clientB
        .from("bookings")
        .select("id")
        .eq("tenant_id", fx.tenantA.id);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("bookings: userA CAN SELECT own tenant row", async () => {
      const clientA = await authedClient(fx.userA.email, fx.userA.password);
      const { data, error } = await clientA
        .from("bookings")
        .select("id")
        .eq("id", bookingAId);
      expect(error).toBeNull();
      expect(data?.length).toBe(1);
    });

    it("commissions: userB cannot SELECT tenantA rows", async () => {
      const clientB = await authedClient(fx.userB.email, fx.userB.password);
      const { data, error } = await clientB
        .from("commissions")
        .select("id")
        .eq("tenant_id", fx.tenantA.id);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("subcontractors: userB cannot SELECT tenantA rows", async () => {
      const clientB = await authedClient(fx.userB.email, fx.userB.password);
      const { data, error } = await clientB
        .from("subcontractors")
        .select("id")
        .eq("tenant_id", fx.tenantA.id);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("payout_balances: userB cannot SELECT tenantA balance", async () => {
      const clientB = await authedClient(fx.userB.email, fx.userB.password);
      const { data, error } = await clientB
        .from("payout_balances")
        .select("tenant_id")
        .eq("tenant_id", fx.tenantA.id);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("payout_records: userB cannot SELECT tenantA records", async () => {
      const clientB = await authedClient(fx.userB.email, fx.userB.password);
      const { data, error } = await clientB
        .from("payout_records")
        .select("id")
        .eq("tenant_id", fx.tenantA.id);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("stripe_webhook_events: userA can SELECT own-tenant events", async () => {
      const clientA = await authedClient(fx.userA.email, fx.userA.password);
      const { data, error } = await clientA
        .from("stripe_webhook_events")
        .select("stripe_event_id")
        .eq("tenant_id", fx.tenantA.id);
      expect(error).toBeNull();
      expect(data?.length).toBeGreaterThanOrEqual(1);
    });

    it("stripe_webhook_events: authenticated users CANNOT SELECT null-tenant (platform) events", async () => {
      const clientA = await authedClient(fx.userA.email, fx.userA.password);
      const { data, error } = await clientA
        .from("stripe_webhook_events")
        .select("stripe_event_id")
        .is("tenant_id", null);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });
  });

  // ── §12.1 contacts isolation + §12.2 FK unique constraint ─────────────────

  describe("contacts + contact_relationships", () => {
    let contactAId: string;
    let contactBId: string;

    beforeAll(async () => {
      if (!fx) return;
      const { sql, tenantA, tenantB } = fx;

      const [cA] = await sql<{ id: string }[]>`
        INSERT INTO public.contacts (tenant_id, first_name, last_name)
        VALUES (${tenantA.id}, 'RLS', 'ContactA')
        RETURNING id
      `;
      if (!cA) throw new Error("contactA insert failed");
      contactAId = cA.id;

      const [cB] = await sql<{ id: string }[]>`
        INSERT INTO public.contacts (tenant_id, first_name, last_name)
        VALUES (${tenantB.id}, 'RLS', 'ContactB')
        RETURNING id
      `;
      if (!cB) throw new Error("contactB insert failed");
      contactBId = cB.id;
    }, 30000);

    afterAll(async () => {
      if (!fx) return;
      const { sql } = fx;
      await sql`DELETE FROM public.contact_relationships WHERE from_contact_id = ${contactAId} OR to_contact_id = ${contactAId}`;
      await sql`DELETE FROM public.contacts WHERE id IN (${contactAId}, ${contactBId})`;
    }, 30000);

    it("§12.1: userA CAN SELECT own tenantA contacts", async () => {
      const clientA = await authedClient(fx.userA.email, fx.userA.password);
      const { data, error } = await clientA
        .from("contacts")
        .select("id")
        .eq("id", contactAId);
      expect(error).toBeNull();
      expect(data?.length).toBe(1);
    });

    it("§12.1: userB cannot SELECT tenantA contacts", async () => {
      const clientB = await authedClient(fx.userB.email, fx.userB.password);
      const { data, error } = await clientB
        .from("contacts")
        .select("id")
        .eq("tenant_id", fx.tenantA.id);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("§12.2: duplicate contact_relationship edge is rejected (UNIQUE 23505)", async () => {
      const { sql, tenantA } = fx;
      // Establish the edge so the second insert can collide against it.
      await sql`
        INSERT INTO public.contact_relationships
          (tenant_id, from_contact_id, to_contact_id, relationship_type)
        VALUES (${tenantA.id}, ${contactAId}, ${contactAId}, 'self_reference_test')
      `;
      // The schema's UNIQUE constraint must be enforced at the DB layer, not just app logic.
      await expect(
        sql`
          INSERT INTO public.contact_relationships
            (tenant_id, from_contact_id, to_contact_id, relationship_type)
          VALUES (${tenantA.id}, ${contactAId}, ${contactAId}, 'self_reference_test')
        `
      ).rejects.toSatisfy((err: unknown) => /23505/.test(String(err)));
    });
  });
});
