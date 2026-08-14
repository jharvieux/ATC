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
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_URL = process.env.SUPABASE_DB_URL;

const haveSupabase = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_KEY && DB_URL);

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

describe.skipIf(!haveSupabase)("RLS integration", () => {
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
    await assertIsolationQuery({
      query: () => clientA
        .from("users")
        .select("id, tenant_id")
        .eq("tenant_id", fx.tenantB.id),
      allowedIds: [],
      deniedIds: [fx.userB.rowId],
    });
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

  it("#2037 — only the service-role orphan-purge RPC can delete aged help sessions", async () => {
    const oldStartedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const recentStartedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const seededIds: string[] = [];

    const seedSession = async (startedAt: string): Promise<string> => {
      const [session] = await fx.sql<{ id: string }[]>`
        INSERT INTO public.help_sessions (tenant_id, user_id, session_type, source_surface, started_at)
        VALUES (${fx.tenantA.id}, ${fx.userA.rowId}, 'help', 'admin', ${startedAt})
        RETURNING id
      `;
      if (!session) throw new Error("#2037 help-session fixture insert failed");
      seededIds.push(session.id);
      return session.id;
    };

    try {
      const oldOrphanId = await seedSession(oldStartedAt);
      const oldBugId = await seedSession(oldStartedAt);
      const oldFeatureId = await seedSession(oldStartedAt);
      const recentOrphanId = await seedSession(recentStartedAt);

      await fx.sql`
        INSERT INTO public.bug_submissions (help_session_id, tenant_id, submitter_user_id, source_type)
        VALUES (${oldBugId}, ${fx.tenantA.id}, ${fx.userA.rowId}, 'tenant_admin')
      `;
      await fx.sql`
        INSERT INTO public.feature_requests (help_session_id, tenant_id, submitter_user_id, source_type)
        VALUES (${oldFeatureId}, ${fx.tenantA.id}, ${fx.userA.rowId}, 'tenant_admin')
      `;

      await expect(
        fx.sql.begin(async (tx) => {
          await tx`SET LOCAL ROLE service_role`;
          await tx`SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true)`;
          await tx`
            SELECT public.purge_orphaned_help_sessions(${cutoff}, 1000)
          `;
        }),
      ).rejects.toSatisfy((error: unknown) => (error as { code?: string }).code === "42501");

      const afterRejectedCall = await fx.sql<{ id: string }[]>`
        SELECT id FROM public.help_sessions WHERE id = ${oldOrphanId}
      `;
      expect(afterRejectedCall).toEqual([{ id: oldOrphanId }]);

      const purged = await fx.admin.rpc("purge_orphaned_help_sessions", {
        p_cutoff: cutoff,
        p_limit: 1000,
      });
      expect(purged.error).toBeNull();
      expect(purged.data).toBe(1);

      const remaining = await fx.sql<{ id: string }[]>`
        SELECT id FROM public.help_sessions
        WHERE id IN (${oldOrphanId}, ${oldBugId}, ${oldFeatureId}, ${recentOrphanId})
      `;
      expect(remaining.map((row) => row.id).sort()).toEqual(
        [oldBugId, oldFeatureId, recentOrphanId].sort(),
      );

      const directDelete = await fx.admin.from("help_sessions").delete().eq("id", recentOrphanId);
      expect(directDelete.error).not.toBeNull();
      expect(directDelete.error?.code).toBe("42501");

      const privileges = await fx.sql<{ grantee: string }[]>`
        SELECT grantee
        FROM information_schema.routine_privileges
        WHERE routine_schema = 'public'
          AND routine_name = 'purge_orphaned_help_sessions'
          AND privilege_type = 'EXECUTE'
          AND grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role')
        ORDER BY grantee
      `;
      expect(privileges).toEqual([{ grantee: "service_role" }]);
    } finally {
      await fx.sql`DELETE FROM public.feature_requests WHERE help_session_id = ANY(${seededIds})`;
      await fx.sql`DELETE FROM public.bug_submissions WHERE help_session_id = ANY(${seededIds})`;
      await fx.sql`DELETE FROM public.help_sessions WHERE id = ANY(${seededIds})`;
    }
  });

  // ── BP05 domain tables ────────────────────────────────────────────────────
  // One cross-tenant isolation check per new table. Also verifies that
  // suspended-tenant users can SELECT but cannot INSERT on conversations,
  // bookings, and subcontractors.

  describe("BP05 domain tables RLS", () => {
    let convAId: string;
    let convSuspId: string;
    let bookingAId: string;
    let commissionAId: string;

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
      const [commission] = await sql<{ id: string }[]>`
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
        RETURNING id
      `;
      if (!commission) throw new Error("commission A insert failed");
      commissionAId = commission.id;

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
      await assertIsolationQuery({
        query: () => clientB
          .from("conversations")
          .select("id")
          .eq("tenant_id", fx.tenantA.id),
        allowedIds: [],
        deniedIds: [convAId],
      });
    });

    it("conversations: suspended user CANNOT SELECT or INSERT (auth_user_can_access_conversation requires active status)", async () => {
      // Post-#908: auth_user_can_access_conversation checks u.status='active' in both
      // owner + staff branches. A suspended user's status is not 'active', so they
      // are blocked at the DB layer on both SELECT and INSERT. This is intentionally
      // stricter than the users-table policy (which still permits read-only self-access).
      const client = await authedClient(fx.userSuspended.email, fx.userSuspended.password);
      const sel = await client
        .from("conversations")
        .select("id")
        .eq("id", convSuspId);
      expect(sel.error).toBeNull();
      expect(sel.data?.length).toBe(0);

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
      await assertIsolationQuery({
        query: () => clientB
          .from("bookings")
          .select("id")
          .eq("tenant_id", fx.tenantA.id),
        allowedIds: [],
        deniedIds: [bookingAId],
      });
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
      await assertIsolationQuery({
        query: () => clientB
          .from("commissions")
          .select("id")
          .eq("tenant_id", fx.tenantA.id),
        allowedIds: [],
        deniedIds: [commissionAId],
      });
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

  describe("unit-scope companion policies", () => {
    let customerMemoryAId: string;
    let anonymousSessionAId: string;
    let groupAId: string;
    let forumAId: string;
    let forumThreadAId: string;
    let importQueueAId: string;
    let bookingAId: string;
    let tripResourceAId: string;

    beforeAll(async () => {
      if (!fx) return;
      const { sql, tenantA, userA } = fx;

      const [customerMemory] = await sql<{ id: string }[]>`
        INSERT INTO public.customer_memories (tenant_id, user_id, notes_freeform)
        VALUES (${tenantA.id}, ${userA.rowId}, 'unit-scope companion fixture')
        RETURNING id
      `;
      if (!customerMemory) throw new Error("customer memory insert failed");
      customerMemoryAId = customerMemory.id;

      const [anonymousSession] = await sql<{ id: string }[]>`
        INSERT INTO public.anonymous_sessions (tenant_id, last_active_at)
        VALUES (${tenantA.id}, NOW())
        RETURNING id
      `;
      if (!anonymousSession) throw new Error("anonymous session insert failed");
      anonymousSessionAId = anonymousSession.id;

      const [group] = await sql<{ id: string }[]>`
        INSERT INTO public.groups (
          tenant_id, coordinator_user_id, cruise_line, ship_name,
          sailing_date, departure_port
        ) VALUES (
          ${tenantA.id}, ${userA.rowId}, 'Test Line', 'Test Ship',
          CURRENT_DATE + 30, 'Test Port'
        )
        RETURNING id
      `;
      if (!group) throw new Error("group insert failed");
      groupAId = group.id;

      const [forum] = await sql<{ id: string }[]>`
        INSERT INTO public.forums (group_id, tenant_id)
        VALUES (${groupAId}, ${tenantA.id})
        RETURNING id
      `;
      if (!forum) throw new Error("forum insert failed");
      forumAId = forum.id;

      const [thread] = await sql<{ id: string }[]>`
        INSERT INTO public.forum_threads (
          forum_id, tenant_id, created_by_user_id, title
        ) VALUES (
          ${forumAId}, ${tenantA.id}, ${userA.rowId}, 'Companion RLS thread'
        )
        RETURNING id
      `;
      if (!thread) throw new Error("forum thread insert failed");
      forumThreadAId = thread.id;

      const [importQueue] = await sql<{ id: string }[]>`
        INSERT INTO public.import_queue (tenant_id, import_path, source_ref)
        VALUES (${tenantA.id}, 'manual', ${RUN_TAG + '-import'})
        RETURNING id
      `;
      if (!importQueue) throw new Error("import queue insert failed");
      importQueueAId = importQueue.id;

      const [booking] = await sql<{ id: string }[]>`
        INSERT INTO public.bookings (tenant_id, booking_type, status)
        VALUES (${tenantA.id}, 'cruise', 'draft')
        RETURNING id
      `;
      if (!booking) throw new Error("companion booking insert failed");
      bookingAId = booking.id;

      const [tripResource] = await sql<{ id: string }[]>`
        INSERT INTO public.trip_resources (
          tenant_id, booking_id, access_token, status
        ) VALUES (
          ${tenantA.id}, ${bookingAId}, ${RUN_TAG + '-resource-token'}, 'draft'
        )
        RETURNING id
      `;
      if (!tripResource) throw new Error("trip resource insert failed");
      tripResourceAId = tripResource.id;
    }, 30000);

    afterAll(async () => {
      if (!fx) return;
      const { sql, tenantA, userA } = fx;
      await sql`DELETE FROM public.trip_resources WHERE id = ${tripResourceAId}`;
      await sql`DELETE FROM public.bookings WHERE id = ${bookingAId}`;
      await sql`DELETE FROM public.import_queue WHERE id = ${importQueueAId}`;
      await sql`DELETE FROM public.forum_threads WHERE id = ${forumThreadAId}`;
      await sql`DELETE FROM public.forums WHERE id = ${forumAId}`;
      await sql`DELETE FROM public.groups WHERE id = ${groupAId}`;
      await sql`DELETE FROM public.anonymous_sessions WHERE id = ${anonymousSessionAId}`;
      await sql`
        DELETE FROM public.customer_memories
        WHERE tenant_id = ${tenantA.id} AND user_id = ${userA.rowId}
      `;
    }, 30000);

    it("customer_memories: userB cannot SELECT tenantA rows", async () => {
      const clientB = await authedClient(fx.userB.email, fx.userB.password);
      await assertIsolationQuery({
        query: () => clientB
          .from("customer_memories")
          .select("id")
          .eq("tenant_id", fx.tenantA.id),
        allowedIds: [],
        deniedIds: [customerMemoryAId],
      });
    });

    it("anonymous_sessions: userB cannot SELECT tenantA rows", async () => {
      const clientB = await authedClient(fx.userB.email, fx.userB.password);
      await assertIsolationQuery({
        query: () => clientB
          .from("anonymous_sessions")
          .select("id")
          .eq("id", anonymousSessionAId),
        allowedIds: [],
        deniedIds: [anonymousSessionAId],
      });
    });

    it("groups: userB cannot SELECT tenantA rows", async () => {
      const clientB = await authedClient(fx.userB.email, fx.userB.password);
      await assertIsolationQuery({
        query: () => clientB
          .from("groups")
          .select("id")
          .eq("id", groupAId),
        allowedIds: [],
        deniedIds: [groupAId],
      });
    });

    it("forums: userB cannot SELECT tenantA rows", async () => {
      const clientB = await authedClient(fx.userB.email, fx.userB.password);
      await assertIsolationQuery({
        query: () => clientB
          .from("forums")
          .select("id")
          .eq("id", forumAId),
        allowedIds: [],
        deniedIds: [forumAId],
      });
    });

    it("forum_threads: userB cannot SELECT tenantA rows", async () => {
      const clientB = await authedClient(fx.userB.email, fx.userB.password);
      await assertIsolationQuery({
        query: () => clientB
          .from("forum_threads")
          .select("id")
          .eq("id", forumThreadAId),
        allowedIds: [],
        deniedIds: [forumThreadAId],
      });
    });

    it("import_queue: userB cannot SELECT tenantA rows", async () => {
      const clientB = await authedClient(fx.userB.email, fx.userB.password);
      await assertIsolationQuery({
        query: () => clientB
          .from("import_queue")
          .select("id")
          .eq("id", importQueueAId),
        allowedIds: [],
        deniedIds: [importQueueAId],
      });
    });

    it("trip_resources: userB cannot SELECT tenantA rows", async () => {
      const clientB = await authedClient(fx.userB.email, fx.userB.password);
      await assertIsolationQuery({
        query: () => clientB
          .from("trip_resources")
          .select("id")
          .eq("id", tripResourceAId),
        allowedIds: [],
        deniedIds: [tripResourceAId],
      });
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

    it("§12.1: userB cannot SELECT tenantA contact (contactAId)", async () => {
      const clientB = await authedClient(fx.userB.email, fx.userB.password);
      const { data, error } = await clientB
        .from("contacts")
        .select("id")
        .eq("id", contactAId);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("§12.1: userA cannot SELECT tenantB contact (contactBId)", async () => {
      const clientA = await authedClient(fx.userA.email, fx.userA.password);
      await assertIsolationQuery({
        query: () => clientA
          .from("contacts")
          .select("id")
          .eq("id", contactBId),
        allowedIds: [],
        deniedIds: [contactBId],
      });
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
      // postgres.js puts the SQLSTATE on err.code; String(err) is the message text only (no code),
      // so a /23505/ regex over the stringified error never matches a real unique violation.
      await expect(
        sql`
          INSERT INTO public.contact_relationships
            (tenant_id, from_contact_id, to_contact_id, relationship_type)
          VALUES (${tenantA.id}, ${contactAId}, ${contactAId}, 'self_reference_test')
        `
      ).rejects.toSatisfy((err: unknown) => (err as { code?: string }).code === "23505");
    });
  });

  // #1523 / D-295 — SECURITY DEFINER tenant-helper functions exposed at
  // /rest/v1/rpc. The Supabase security advisor flags auth_user_in_tenant,
  // tenant_is_active, and auth_user_can_access_conversation as EXECUTE-able by
  // `authenticated` and suggests REVOKE. That REVOKE was proven to break every
  // tenant RLS policy (#1369, closed not-planned): Postgres evaluates a policy's
  // USING/WITH CHECK as the querying role, so `authenticated` must hold EXECUTE
  // on the helpers the policy calls — the grant is load-bearing, not an
  // oversight. These tests are the #1523 acceptance-criteria RLS regression:
  // they assert the grant stays (a re-applied REVOKE surfaces as a 42501 here,
  // not as a silent prod outage) AND that each helper is caller-scoped, which
  // is why the residual RPC exposure is an accepted risk rather than a leak.
  describe("#1523 SECURITY DEFINER helper RPC grants (D-295 keep-the-grant)", () => {
    let convId: string;

    beforeAll(async () => {
      if (!fx) return;
      const [conv] = await fx.sql<{ id: string }[]>`
        INSERT INTO public.conversations (tenant_id, user_id, title, status)
        VALUES (${fx.tenantA.id}, ${fx.userA.rowId}, '1523 rpc helper test', 'active')
        RETURNING id
      `;
      if (!conv) throw new Error("1523 conversation fixture insert failed");
      convId = conv.id;
    }, 30000);

    afterAll(async () => {
      if (!fx) return;
      await fx.sql`DELETE FROM public.conversations WHERE id = ${convId}`;
    }, 30000);

    it("auth_user_in_tenant: authenticated can EXECUTE; result is caller-scoped", async () => {
      const clientA = await authedClient(fx.userA.email, fx.userA.password);
      // Own tenant → true. A revoked grant would surface as error 42501 here.
      const own = await clientA.rpc("auth_user_in_tenant", {
        target_tenant_id: fx.tenantA.id,
      });
      expect(own.error).toBeNull();
      expect(own.data).toBe(true);
      // Non-member tenant → false: the helper reads the CALLER's membership
      // (auth.uid()), so it cannot be used to probe other users' memberships.
      const other = await clientA.rpc("auth_user_in_tenant", {
        target_tenant_id: fx.tenantB.id,
      });
      expect(other.error).toBeNull();
      expect(other.data).toBe(false);
    });

    it("tenant_is_active: authenticated can EXECUTE; reflects tenant status", async () => {
      const clientA = await authedClient(fx.userA.email, fx.userA.password);
      const active = await clientA.rpc("tenant_is_active", {
        target_tenant_id: fx.tenantA.id,
      });
      expect(active.error).toBeNull();
      expect(active.data).toBe(true);
      const suspended = await clientA.rpc("tenant_is_active", {
        target_tenant_id: fx.tenantSuspended.id,
      });
      expect(suspended.error).toBeNull();
      expect(suspended.data).toBe(false);
    });

    it("auth_user_can_access_conversation: authenticated can EXECUTE; result is caller-scoped", async () => {
      // Owner in own tenant → true.
      const clientA = await authedClient(fx.userA.email, fx.userA.password);
      const owner = await clientA.rpc("auth_user_can_access_conversation", {
        conv_id: convId,
        target_tenant_id: fx.tenantA.id,
      });
      expect(owner.error).toBeNull();
      expect(owner.data).toBe(true);
      // A user from a different tenant → false: the helper resolves the
      // caller's membership in target_tenant_id, so it cannot leak another
      // tenant's conversation access.
      const clientB = await authedClient(fx.userB.email, fx.userB.password);
      const outsider = await clientB.rpc("auth_user_can_access_conversation", {
        conv_id: convId,
        target_tenant_id: fx.tenantA.id,
      });
      expect(outsider.error).toBeNull();
      expect(outsider.data).toBe(false);
    });
  });

  describe("#2072 help-docs storage tenant isolation", () => {
    const objectName = `${RUN_TAG}.pdf`;

    beforeAll(async () => {
      const uploads = await Promise.all([
        fx.admin.storage
          .from("help-docs")
          .upload(`tenant_${fx.tenantA.id}/help-docs/${objectName}`, new Blob(["tenant-a"], { type: "application/pdf" }), {
            contentType: "application/pdf",
            upsert: true,
          }),
        fx.admin.storage
          .from("help-docs")
          .upload(`tenant_${fx.tenantB.id}/help-docs/${objectName}`, new Blob(["tenant-b"], { type: "application/pdf" }), {
            contentType: "application/pdf",
            upsert: true,
          }),
      ]);
      for (const upload of uploads) expect(upload.error).toBeNull();
    });

    afterAll(async () => {
      if (!fx) return;
      const cleanup = await fx.admin.storage.from("help-docs").remove([
        `tenant_${fx.tenantA.id}/help-docs/${objectName}`,
        `tenant_${fx.tenantB.id}/help-docs/${objectName}`,
      ]);
      expect(cleanup.error).toBeNull();
    });

    it("keeps the help-docs bucket private", async () => {
      const { data: bucket, error } = await fx.admin.storage.getBucket("help-docs");

      expect(error).toBeNull();
      expect(bucket?.public).toBe(false);
    });

    it("allows an authenticated user to list own-tenant exports", async () => {
      const clientA = await authedClient(fx.userA.email, fx.userA.password);
      const result = await clientA.storage
        .from("help-docs")
        .list(`tenant_${fx.tenantA.id}/help-docs`, { search: objectName });

      expect(result.error).toBeNull();
      expect(result.data?.map((object) => object.name)).toContain(objectName);
    });

    it("denies an authenticated user access to cross-tenant exports", async () => {
      const clientA = await authedClient(fx.userA.email, fx.userA.password);
      const result = await clientA.storage
        .from("help-docs")
        .list(`tenant_${fx.tenantB.id}/help-docs`, { search: objectName });

      expect(result.error).toBeNull();
      expect(result.data).toEqual([]);
    });
  });
});
