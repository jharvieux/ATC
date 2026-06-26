// DB integration tests — atomic chat-limit RPC concurrency
// Issue: #1415
// Spec refs: §24.8 (anon limiter), §24.9 (customer limiter)
// F-sm-01 / F-sm-02 (#1376 / #1377)
//
// Validates that the INSERT … ON CONFLICT DO UPDATE RPCs produce sequential,
// gap-free counter increments under K concurrent callers — proving the
// Postgres-level atomicity that unit tests cannot exercise.
//
// Requires a live Supabase project. Gated on SUPABASE_DB_URL; CI runs this as
// a nightly job, not on every PR.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const adminToken = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;

const haveSupabase = Boolean(supabaseUrl && adminToken && dbUrl);

const describeIf = haveSupabase ? describe : describe.skip;

// Unique tag scopes all fixture rows to this run; afterAll deletes by tag.
const RUN_TAG = `cclim-${randomUUID().slice(0, 8)}`;

// Number of concurrent RPC calls per concurrency test. 10 gives a meaningful
// collision window without making the test fragile on slow CI connections.
const K = 10;

interface Fixtures {
  admin: SupabaseClient;
  sql: ReturnType<typeof postgres>;
  tenantId: string;
  userId: string; // public.users.id (not auth.users.id)
  authId: string; // auth.users.id for direct cleanup
}

let fx: Fixtures;

// Boundary fixture IDs tracked here so afterAll can clean up even if test 3 assertions fail.
let boundaryTenantIdToClean: string | null = null;
let boundaryAuthIdToClean: string | null = null;

describeIf("chat-limit RPC concurrency (DB integration)", () => {
  beforeAll(async () => {
    const admin = createClient(supabaseUrl!, adminToken!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Use a pool size > 1 so concurrent RPC calls actually hit Postgres in
    // parallel rather than being serialised through a single connection.
    const sql = postgres(dbUrl!, { max: K + 2, idle_timeout: 20, onnotice: () => {} });

    // Resolve a tier id — required FK on tenants.
    const tier = await sql<{ id: string }[]>`
      SELECT id FROM public.tier_definitions WHERE code = 'byo_research' LIMIT 1
    `;
    if (!tier[0]) throw new Error("tier_definitions not seeded — apply migrations first");
    const tierId = tier[0].id;

    // Insert a fixture tenant scoped to this run.
    const [tenantRow] = await sql<{ id: string }[]>`
      INSERT INTO public.tenants (slug, display_name, legal_name, tenant_type, status, tier_id)
      VALUES (
        ${RUN_TAG}, ${`ConcurrencyTest ${RUN_TAG}`}, ${`ConcurrencyTest LLC`},
        'byo_host', 'active', ${tierId}
      )
      RETURNING id
    `;
    if (!tenantRow) throw new Error("tenant insert returned no row");
    const tenantId = tenantRow.id;

    // Create an auth user for the customer-limiter tests.
    const email = `${RUN_TAG}@example.test`;
    const created = await admin.auth.admin.createUser({
      email,
      password: `Pw-${randomUUID()}`,
      email_confirm: true,
    });
    if (created.error || !created.data.user) {
      throw new Error(`createUser failed: ${created.error?.message}`);
    }
    const authId = created.data.user.id;

    // Insert the matching public.users row — customer_chat_counters.user_id
    // references public.users.id, not auth.users.id.
    const [userRow] = await sql<{ id: string }[]>`
      INSERT INTO public.users (auth_user_id, tenant_id, email, status)
      VALUES (${authId}, ${tenantId}, ${email}, 'active')
      RETURNING id
    `;
    if (!userRow) throw new Error("user insert returned no row");

    fx = { admin, sql, tenantId, userId: userRow.id, authId };
  }, 60000);

  afterAll(async () => {
    if (!fx) return;
    const { admin, sql, tenantId, userId, authId } = fx;
    try {
      // Delete counter rows first (FK dependencies), then the tenant fixture.
      await sql`DELETE FROM public.customer_chat_counters WHERE user_id = ${userId}`;
      await sql`DELETE FROM public.anonymous_chat_counters WHERE tenant_id = ${tenantId}`;
      await admin.auth.admin.deleteUser(authId).catch(() => {});
      await sql`DELETE FROM public.users WHERE tenant_id = ${tenantId}`;
      await sql.begin(async (tx) => {
        await tx`SET LOCAL app.allow_tenant_hard_delete = 'true'`;
        await tx`DELETE FROM public.tenants WHERE id = ${tenantId}`;
      });
      // Clean up boundary fixture from test 3 (tracked at module level so cleanup
      // runs even if the test assertions threw before reaching the inline cleanup).
      if (boundaryTenantIdToClean) {
        await sql`DELETE FROM public.customer_chat_counters WHERE tenant_id = ${boundaryTenantIdToClean}`;
        await sql`DELETE FROM public.users WHERE tenant_id = ${boundaryTenantIdToClean}`;
        if (boundaryAuthIdToClean) await admin.auth.admin.deleteUser(boundaryAuthIdToClean).catch(() => {});
        await sql.begin(async (tx) => {
          await tx`SET LOCAL app.allow_tenant_hard_delete = 'true'`;
          await tx`DELETE FROM public.tenants WHERE id = ${boundaryTenantIdToClean}`;
        });
      }
    } finally {
      await sql.end();
    }
  }, 60000);

  // ── Test 1: increment_customer_chat_count — K concurrent calls ────────────
  //
  // Fire K=10 parallel calls for the same (user_id, tenant_id). The returned
  // counts must form a contiguous set {1..K} with no duplicates and no gaps,
  // proving the ON CONFLICT DO UPDATE is atomic and not a concurrent RMW race.
  it(
    "increment_customer_chat_count: K concurrent callers get contiguous counts {1..K}",
    async () => {
      const { sql, userId, tenantId } = fx;

      const results = await Promise.all(
        Array.from({ length: K }, () =>
          sql<{ increment_customer_chat_count: number }[]>`
            SELECT public.increment_customer_chat_count(
              ${userId}::uuid,
              ${tenantId}::uuid,
              30
            )
          `.then((rows) => rows[0]!.increment_customer_chat_count),
        ),
      );

      const sorted = [...results].sort((a, b) => a - b);

      // No duplicates — every concurrent call must get a unique count.
      const unique = new Set(results);
      expect(unique.size).toBe(K);

      // Contiguous 1..K — no gaps, no skips.
      expect(sorted).toEqual(Array.from({ length: K }, (_, i) => i + 1));

      // DB row matches final count.
      const [row] = await sql<{ current_count: number }[]>`
        SELECT current_count FROM public.customer_chat_counters
        WHERE user_id = ${userId} AND tenant_id = ${tenantId}
      `;
      expect(row?.current_count).toBe(K);
    },
    30000,
  );

  // ── Test 2: increment_anon_chat_counter — K concurrent calls ─────────────
  //
  // Same atomicity proof for the anon limiter; uses a unique session identifier
  // so it doesn't collide with any other test run.
  it(
    "increment_anon_chat_counter: K concurrent callers get contiguous counts {1..K}",
    async () => {
      const { sql, tenantId } = fx;
      const sessionId = randomUUID();

      const results = await Promise.all(
        Array.from({ length: K }, () =>
          sql<{ increment_anon_chat_counter: number }[]>`
            SELECT public.increment_anon_chat_counter(
              ${tenantId}::uuid,
              'session',
              ${sessionId},
              NULL
            )
          `.then((rows) => rows[0]!.increment_anon_chat_counter),
        ),
      );

      const sorted = [...results].sort((a, b) => a - b);

      const unique = new Set(results);
      expect(unique.size).toBe(K);
      expect(sorted).toEqual(Array.from({ length: K }, (_, i) => i + 1));

      const [row] = await sql<{ current_count: number }[]>`
        SELECT current_count FROM public.anonymous_chat_counters
        WHERE identifier_type = 'session'
          AND identifier_value = ${sessionId}
          AND tenant_id = ${tenantId}
      `;
      expect(row?.current_count).toBe(K);
    },
    30000,
  );

  // ── Test 3: increment_customer_chat_count — no duplicate/gap at an arbitrary boundary ──
  //
  // Seed the counter row at 39. Fire K=10 parallel calls. The RPC is a pure
  // atomic counter — it does not enforce any cap (cap enforcement is app-layer
  // in customer-limit.ts). The "30" arg is p_window_days, not a cap value.
  //
  // This test proves atomicity across a boundary:
  //   - No caller receives ≤ 39 (all incremented from the seed).
  //   - Exactly one caller receives 40 (the increment from 39 is not duplicated).
  //   - The remaining K-1 callers receive > 40 (no lost updates).
  it(
    "increment_customer_chat_count: exactly one caller crosses the boundary at seed=39",
    async () => {
      const { sql } = fx;

      // Fresh user/tenant pair to avoid interference from Test 1.
      const sessionUserTag = `${RUN_TAG}-boundary`;
      const [tenantRow] = await sql<{ id: string }[]>`
        INSERT INTO public.tenants (slug, display_name, legal_name, tenant_type, status, tier_id)
        SELECT
          ${sessionUserTag},
          'BoundaryTest',
          'BoundaryTest LLC',
          'byo_host',
          'active',
          t.id
        FROM public.tier_definitions t WHERE t.code = 'byo_research' LIMIT 1
        RETURNING id
      `;
      if (!tenantRow) throw new Error("boundary tenant insert returned no row");
      const boundaryTenantId = tenantRow.id;
      // Register for afterAll cleanup before any await that might throw.
      boundaryTenantIdToClean = boundaryTenantId;

      const email2 = `${sessionUserTag}@example.test`;
      const created2 = await fx.admin.auth.admin.createUser({
        email: email2,
        password: `Pw-${randomUUID()}`,
        email_confirm: true,
      });
      if (created2.error || !created2.data.user) {
        throw new Error(`createUser failed: ${created2.error?.message}`);
      }
      const authId2 = created2.data.user.id;
      boundaryAuthIdToClean = authId2;
      const [userRow2] = await sql<{ id: string }[]>`
        INSERT INTO public.users (auth_user_id, tenant_id, email, status)
        VALUES (${authId2}, ${boundaryTenantId}, ${email2}, 'active')
        RETURNING id
      `;
      if (!userRow2) throw new Error("boundary user insert returned no row");
      const boundaryUserId = userRow2.id;

      // Seed the counter row at count=39 (cap - 1).
      // One increment call creates the row, then we update it to 39.
      await sql`
        SELECT public.increment_customer_chat_count(
          ${boundaryUserId}::uuid,
          ${boundaryTenantId}::uuid,
          30
        )
      `;
      await sql`
        UPDATE public.customer_chat_counters
        SET current_count = 39
        WHERE user_id = ${boundaryUserId} AND tenant_id = ${boundaryTenantId}
      `;

      // Verify the seed is in place before firing the concurrent burst.
      const [seeded] = await sql<{ current_count: number }[]>`
        SELECT current_count FROM public.customer_chat_counters
        WHERE user_id = ${boundaryUserId} AND tenant_id = ${boundaryTenantId}
      `;
      expect(seeded?.current_count).toBe(39);

      // Fire K concurrent calls — exactly one should return 40.
      const results = await Promise.all(
        Array.from({ length: K }, () =>
          sql<{ increment_customer_chat_count: number }[]>`
            SELECT public.increment_customer_chat_count(
              ${boundaryUserId}::uuid,
              ${boundaryTenantId}::uuid,
              30
            )
          `.then((rows) => rows[0]!.increment_customer_chat_count),
        ),
      );

      // No caller receives ≤ 39 — all incremented from the seeded value.
      const belowBoundary = results.filter((c) => c <= 39);
      expect(belowBoundary).toHaveLength(0);

      // Exactly one caller crosses the boundary at 40 (the seed+1 slot is not duplicated).
      const atBoundary = results.filter((c) => c === 40);
      expect(atBoundary).toHaveLength(1);

      // The rest received counts above 40 (no lost updates).
      const aboveBoundary = results.filter((c) => c > 40);
      expect(aboveBoundary).toHaveLength(K - 1);

      // Cleanup handled in afterAll via boundaryTenantIdToClean / boundaryAuthIdToClean.
    },
    60000,
  );
});
