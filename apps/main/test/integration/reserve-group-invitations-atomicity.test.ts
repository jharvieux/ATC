// DB integration tests — atomic group-invitation reservation RPC (#1680, #1875)
// Spec refs: §18.2 / §18.5 (per-group active-invitee cap)
//
// Proves the property the unit tests structurally cannot: that
// public.reserve_group_invitations enforces the 50-active-invitee cap inside
// ONE advisory-lock-serialized transaction. The unit tests all mock the RPC
// verdict, so the cap arithmetic (v_active + v_incoming > p_max) and the
// pg_advisory_xact_lock serialization are never exercised — a bug in either
// (off-by-one on the boundary, or a missing/ineffective lock letting two
// concurrent reservations both read a stale count and overshoot the cap) would
// pass every unit test. This test drives the real function against a live DB.
//
// Requires a live DB. Gated on NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// + SUPABASE_DB_URL; runs as a nightly job, not on every PR (same idiom as
// chat-limit-concurrency.test.ts and import-promote-atomicity.test.ts).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { MAX_INVITEES_PER_GROUP } from "@/lib/groups/constants";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const adminToken = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;

const haveSupabase = Boolean(supabaseUrl && adminToken && dbUrl);
const describeIf = haveSupabase ? describe : describe.skip;

const RUN_TAG = `resv-${randomUUID().slice(0, 8)}`;
const CAP = MAX_INVITEES_PER_GROUP; // 50 — passed to the RPC as p_max

interface Fixtures {
  admin: SupabaseClient;
  sql: ReturnType<typeof postgres>;
  tenantId: string;
  coordinatorUserId: string;
  authId: string;
}
let fx: Fixtures;

// One RPC-payload element in the shape reserve_group_invitations reads
// (r->>'id','invitee_email','invitee_name','personal_note','visibility_choice','token').
function makeInvite() {
  const id = randomUUID();
  return {
    id,
    invitee_email: `${RUN_TAG}-${id.slice(0, 8)}@example.test`,
    invitee_name: null,
    personal_note: null,
    visibility_choice: "no_opinion",
    token: `tok-${id}`,
  };
}

async function seedGroup(): Promise<string> {
  const [row] = await fx.sql<{ id: string }[]>`
    INSERT INTO public.groups
      (tenant_id, coordinator_user_id, cruise_line, ship_name, sailing_date, departure_port)
    VALUES
      (${fx.tenantId}, ${fx.coordinatorUserId}, 'Carnival', 'Vista', '2026-09-01', 'Miami')
    RETURNING id
  `;
  if (!row) throw new Error("group insert returned nothing");
  return row.id;
}

// Seed n *active* invitations (token_revoked_at null) directly, bypassing the RPC,
// so each test starts from a known active count.
async function seedActiveInvitations(groupId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const inv = makeInvite();
    await fx.sql`
      INSERT INTO public.invitations (id, group_id, invitee_email, token)
      VALUES (${inv.id}::uuid, ${groupId}::uuid, ${inv.invitee_email}, ${inv.token})
    `;
  }
}

async function activeCount(groupId: string): Promise<number> {
  const [row] = await fx.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM public.invitations
    WHERE group_id = ${groupId} AND token_revoked_at IS NULL
  `;
  return row!.n;
}

describeIf("reserve_group_invitations RPC atomicity (DB integration)", () => {
  beforeAll(async () => {
    const admin = createClient(supabaseUrl!, adminToken!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const sql = postgres(dbUrl!, { max: 6, idle_timeout: 20, onnotice: () => {} });

    const tier = await sql<{ id: string }[]>`SELECT id FROM public.tier_definitions WHERE code = 'byo_research' LIMIT 1`;
    if (!tier[0]) throw new Error("tier_definitions not seeded — apply migrations first");

    const [tenantRow] = await sql<{ id: string }[]>`
      INSERT INTO public.tenants (slug, display_name, legal_name, tenant_type, status, tier_id)
      VALUES (${RUN_TAG}, ${`ReserveTest ${RUN_TAG}`}, 'ReserveTest LLC', 'byo_host', 'active', ${tier[0].id})
      RETURNING id
    `;
    if (!tenantRow) throw new Error("tenant insert returned no row");

    // groups.coordinator_user_id references public.users.id (not auth.users.id).
    const email = `${RUN_TAG}@example.test`;
    const created = await admin.auth.admin.createUser({
      email,
      password: `Pw-${randomUUID()}`,
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw new Error(`createUser failed: ${created.error?.message}`);
    const authId = created.data.user.id;

    const [userRow] = await sql<{ id: string }[]>`
      INSERT INTO public.users (auth_user_id, tenant_id, email, status)
      VALUES (${authId}, ${tenantRow.id}, ${email}, 'active')
      RETURNING id
    `;
    if (!userRow) throw new Error("user insert returned no row");

    fx = { admin, sql, tenantId: tenantRow.id, coordinatorUserId: userRow.id, authId };
  }, 60000);

  afterAll(async () => {
    if (!fx) return;
    const { admin, sql, tenantId, authId } = fx;
    try {
      // invitations cascade on group delete (ON DELETE CASCADE).
      await sql`DELETE FROM public.groups WHERE tenant_id = ${tenantId}`;
      await admin.auth.admin.deleteUser(authId).catch(() => {});
      await sql`DELETE FROM public.users WHERE tenant_id = ${tenantId}`;
      await sql.begin(async (tx) => {
        await tx`SET LOCAL app.allow_tenant_hard_delete = 'true'`;
        await tx`DELETE FROM public.tenants WHERE id = ${tenantId}`;
      });
    } finally {
      await sql.end();
    }
  }, 60000);

  // ── Test 1: 49 active + 1 → ok, inserted, active becomes 50 ──────────────────
  it(
    "49 active + 1 lands exactly on the cap: status ok, one row inserted",
    async () => {
      const groupId = await seedGroup();
      await seedActiveInvitations(groupId, CAP - 1); // 49
      expect(await activeCount(groupId)).toBe(CAP - 1);

      const { data, error } = await fx.admin.rpc("reserve_group_invitations", {
        p_group_id: groupId,
        p_invitations: [makeInvite()],
        p_max: CAP,
      });
      expect(error).toBeNull();
      expect(data).toMatchObject({ status: "ok", inserted: 1 });
      expect(await activeCount(groupId)).toBe(CAP); // exactly 50
    },
    60000,
  );

  // ── Test 2: 50 active + 1 → cap_exceeded, nothing inserted ───────────────────
  it(
    "50 active + 1 crosses the cap: status cap_exceeded, zero rows inserted",
    async () => {
      const groupId = await seedGroup();
      await seedActiveInvitations(groupId, CAP); // 50
      expect(await activeCount(groupId)).toBe(CAP);

      const { data, error } = await fx.admin.rpc("reserve_group_invitations", {
        p_group_id: groupId,
        p_invitations: [makeInvite()],
        p_max: CAP,
      });
      expect(error).toBeNull();
      expect(data).toMatchObject({ status: "cap_exceeded", active_count: CAP });
      expect(await activeCount(groupId)).toBe(CAP); // unchanged — batch rejected atomically
    },
    60000,
  );

  // ── Test 3: existing + batch > cap → cap_exceeded, zero of the batch inserted ─
  it(
    "45 active + batch of 10 (would be 55) is rejected whole: cap_exceeded, none of the batch inserted",
    async () => {
      const groupId = await seedGroup();
      await seedActiveInvitations(groupId, 45);
      expect(await activeCount(groupId)).toBe(45);

      const batch = Array.from({ length: 10 }, () => makeInvite());
      const { data, error } = await fx.admin.rpc("reserve_group_invitations", {
        p_group_id: groupId,
        p_invitations: batch,
        p_max: CAP,
      });
      expect(error).toBeNull();
      expect(data).toMatchObject({ status: "cap_exceeded", active_count: 45 });
      // Whole batch rejected — not a partial fill up to the cap.
      expect(await activeCount(groupId)).toBe(45);
    },
    60000,
  );

  // ── Test 4: two concurrent same-group reservations at the cap → exactly one wins
  //
  // This is the #1680 serialization proof. Seed 49 active, fire TWO concurrent
  // 1-invite reservations. pg_advisory_xact_lock(hashtext(group_id)) serializes
  // them: the winner counts 49, inserts (49+1=50 ≤ cap), commits & releases the
  // lock; the loser then counts 50 and is refused (50+1=51 > cap). Without the
  // lock both could read 49 and both insert → 51 (the TOCTOU this PR closes).
  it(
    "two concurrent reservations racing the last slot: exactly one ok, one cap_exceeded, final active = cap",
    async () => {
      const groupId = await seedGroup();
      await seedActiveInvitations(groupId, CAP - 1); // 49
      expect(await activeCount(groupId)).toBe(CAP - 1);

      const results = await Promise.all(
        Array.from({ length: 2 }, async () => {
          const { data, error } = await fx.admin.rpc("reserve_group_invitations", {
            p_group_id: groupId,
            p_invitations: [makeInvite()],
            p_max: CAP,
          });
          if (error) throw new Error(`rpc failed: ${error.message}`);
          return (data as { status: string }).status;
        }),
      );

      const ok = results.filter((s) => s === "ok");
      const capped = results.filter((s) => s === "cap_exceeded");
      expect(ok).toHaveLength(1);
      expect(capped).toHaveLength(1);
      // Serialization held: exactly one row was added, cap not overshot.
      expect(await activeCount(groupId)).toBe(CAP);
    },
    60000,
  );
});
