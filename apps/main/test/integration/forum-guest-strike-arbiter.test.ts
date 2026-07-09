// DB integration test — guest (invitation-authored) forum_user_state ON
// CONFLICT arbiter.
// Issue: #1721 (follow-up from #1572 / #1709)
// Migration: 20260709111701_forum_user_state_invitation_full_unique.sql
//
// WHY: checkStrikePatterns' guest auto-mute path upserts with
// onConflict: "forum_id,invitation_id". PostgREST/postgres-js emit NO
// predicate for ON CONFLICT, so the PARTIAL unique index added by
// 20260717000000_forum_guest_authors.sql (WHERE invitation_id IS NOT NULL)
// could not serve as an inference arbiter — Postgres raised 42P10 and the
// guest was silently never muted. 20260709111701 replaced it with a FULL
// UNIQUE(forum_id, invitation_id) constraint, which the pre-PR audit on
// #1709 proved live but only via a one-time, rolled-back manual test. Unit
// tests mock db.rpc/db.from entirely and cannot catch a SQL-level arbiter
// regression; this test hits the live DB and calls the real
// checkStrikePatterns function twice to prove the fix holds and stays held.
//
// Requires a live Supabase project. Gated on SUPABASE_DB_URL; CI runs this as
// a nightly job, not on every PR (mirrors rls.test.ts / chat-limit-concurrency.test.ts).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { checkStrikePatterns } from "@/lib/forums/strikes";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const adminToken = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;

const haveSupabase = Boolean(supabaseUrl && adminToken && dbUrl);
const describeIf = haveSupabase ? describe : describe.skip;

// Unique tag scopes all fixture rows to this run; afterAll deletes by tag.
const RUN_TAG = `fusarb-${randomUUID().slice(0, 8)}`;

interface Fixtures {
  admin: SupabaseClient;
  sql: ReturnType<typeof postgres>;
  tenantId: string;
  groupId: string;
  forumId: string;
  invitationId: string;
  coordinatorAuthId: string;
  memberAuthId: string;
  memberUserId: string;
}

let fx: Fixtures;

describeIf("forum_user_state guest ON CONFLICT arbiter (DB integration, #1721)", () => {
  beforeAll(async () => {
    const admin = createClient(supabaseUrl!, adminToken!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const sql = postgres(dbUrl!, { max: 2, idle_timeout: 20, onnotice: () => {} });

    const tier = await sql<{ id: string }[]>`
      SELECT id FROM public.tier_definitions WHERE code = 'byo_research' LIMIT 1
    `;
    if (!tier[0]) throw new Error("tier_definitions not seeded — apply migrations first");
    const tierId = tier[0].id;

    const [tenantRow] = await sql<{ id: string }[]>`
      INSERT INTO public.tenants (slug, display_name, legal_name, tenant_type, status, tier_id)
      VALUES (${RUN_TAG}, ${`ForumArbTest ${RUN_TAG}`}, ${`ForumArbTest LLC`}, 'byo_host', 'active', ${tierId})
      RETURNING id
    `;
    if (!tenantRow) throw new Error("tenant insert returned no row");
    const tenantId = tenantRow.id;

    // Coordinator — required by groups.coordinator_user_id NOT NULL FK.
    const coordEmail = `${RUN_TAG}-coord@example.test`;
    const coordCreated = await admin.auth.admin.createUser({
      email: coordEmail,
      password: `Pw-${randomUUID()}`,
      email_confirm: true,
    });
    if (coordCreated.error || !coordCreated.data.user) {
      throw new Error(`createUser (coordinator) failed: ${coordCreated.error?.message}`);
    }
    const coordinatorAuthId = coordCreated.data.user.id;
    const [coordUserRow] = await sql<{ id: string }[]>`
      INSERT INTO public.users (auth_user_id, tenant_id, email, status)
      VALUES (${coordinatorAuthId}, ${tenantId}, ${coordEmail}, 'active')
      RETURNING id
    `;
    if (!coordUserRow) throw new Error("coordinator user insert returned no row");
    const coordinatorUserId = coordUserRow.id;

    // Second member — the member-side (forum_id,user_id) upsert check.
    const memberEmail = `${RUN_TAG}-member@example.test`;
    const memberCreated = await admin.auth.admin.createUser({
      email: memberEmail,
      password: `Pw-${randomUUID()}`,
      email_confirm: true,
    });
    if (memberCreated.error || !memberCreated.data.user) {
      throw new Error(`createUser (member) failed: ${memberCreated.error?.message}`);
    }
    const memberAuthId = memberCreated.data.user.id;
    const [memberUserRow] = await sql<{ id: string }[]>`
      INSERT INTO public.users (auth_user_id, tenant_id, email, status)
      VALUES (${memberAuthId}, ${tenantId}, ${memberEmail}, 'active')
      RETURNING id
    `;
    if (!memberUserRow) throw new Error("member user insert returned no row");
    const memberUserId = memberUserRow.id;

    const [groupRow] = await sql<{ id: string }[]>`
      INSERT INTO public.groups (tenant_id, coordinator_user_id, cruise_line, ship_name, sailing_date, departure_port)
      VALUES (${tenantId}, ${coordinatorUserId}, 'Test Line', 'Test Ship', '2027-06-01', 'Miami')
      RETURNING id
    `;
    if (!groupRow) throw new Error("group insert returned no row");
    const groupId = groupRow.id;

    const [forumRow] = await sql<{ id: string }[]>`
      INSERT INTO public.forums (group_id, tenant_id)
      VALUES (${groupId}, ${tenantId})
      RETURNING id
    `;
    if (!forumRow) throw new Error("forum insert returned no row");
    const forumId = forumRow.id;

    const [invitationRow] = await sql<{ id: string }[]>`
      INSERT INTO public.invitations (group_id, invitee_email, token)
      VALUES (${groupId}, ${`${RUN_TAG}-guest@example.test`}, ${`tok-${RUN_TAG}`})
      RETURNING id
    `;
    if (!invitationRow) throw new Error("invitation insert returned no row");
    const invitationId = invitationRow.id;

    fx = {
      admin,
      sql,
      tenantId,
      groupId,
      forumId,
      invitationId,
      coordinatorAuthId,
      memberAuthId,
      memberUserId,
    };
  }, 60000);

  afterAll(async () => {
    if (!fx) return;
    const { admin, sql, tenantId, forumId, groupId, invitationId, coordinatorAuthId, memberAuthId } = fx;
    try {
      await sql`DELETE FROM public.forum_user_state WHERE forum_id = ${forumId}`;
      await sql`DELETE FROM public.forum_strikes WHERE forum_id = ${forumId}`;
      await sql`DELETE FROM public.forums WHERE id = ${forumId}`;
      await sql`DELETE FROM public.invitations WHERE id = ${invitationId}`;
      await sql`DELETE FROM public.groups WHERE id = ${groupId}`;
      await sql`DELETE FROM public.users WHERE tenant_id = ${tenantId}`;
      await admin.auth.admin.deleteUser(coordinatorAuthId).catch(() => {});
      await admin.auth.admin.deleteUser(memberAuthId).catch(() => {});
      await sql.begin(async (tx) => {
        await tx`SET LOCAL app.allow_tenant_hard_delete = 'true'`;
        await tx`DELETE FROM public.tenants WHERE id = ${tenantId}`;
      });
    } finally {
      await sql.end();
    }
  }, 60000);

  it("guest (invitation) auto-mute: ON CONFLICT arbiter resolves across two calls without error, exactly one muted row", async () => {
    const { sql, admin, forumId, tenantId, invitationId } = fx;

    // Seed 3 ai_hidden strikes within the last 24h — crosses the auto-mute
    // threshold (checkStrikePatterns' aiHiddenLast24h >= 3 branch).
    await sql`
      INSERT INTO public.forum_strikes (forum_id, invitation_id, tenant_id, strike_kind)
      VALUES
        (${forumId}, ${invitationId}, ${tenantId}, 'ai_hidden'),
        (${forumId}, ${invitationId}, ${tenantId}, 'ai_hidden'),
        (${forumId}, ${invitationId}, ${tenantId}, 'ai_hidden')
    `;

    // Call twice — simulates two evaluations racing the same guest (e.g. two
    // messages hidden in quick succession). Pre-20260709111701, either call
    // raises 42P10 because no arbiter matches a predicate-less ON CONFLICT
    // against the old partial index.
    const first = await checkStrikePatterns(admin, {
      author: { invitation_id: invitationId },
      forum_id: forumId,
      tenant_id: tenantId,
    });
    const second = await checkStrikePatterns(admin, {
      author: { invitation_id: invitationId },
      forum_id: forumId,
      tenant_id: tenantId,
    });

    expect(first.auto_muted).toBe(true);
    expect(second.auto_muted).toBe(true);

    const rows = await sql<{ id: string; is_muted: boolean }[]>`
      SELECT id, is_muted FROM public.forum_user_state
      WHERE forum_id = ${forumId} AND invitation_id = ${invitationId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_muted).toBe(true);
  });

  it("member (user_id) auto-mute: (forum_id,user_id) upsert still works post-migration", async () => {
    const { sql, admin, forumId, tenantId, memberUserId } = fx;

    await sql`
      INSERT INTO public.forum_strikes (forum_id, user_id, tenant_id, strike_kind)
      VALUES
        (${forumId}, ${memberUserId}, ${tenantId}, 'ai_hidden'),
        (${forumId}, ${memberUserId}, ${tenantId}, 'ai_hidden'),
        (${forumId}, ${memberUserId}, ${tenantId}, 'ai_hidden')
    `;

    const result = await checkStrikePatterns(admin, {
      author: { user_id: memberUserId },
      forum_id: forumId,
      tenant_id: tenantId,
    });
    expect(result.auto_muted).toBe(true);

    const rows = await sql<{ id: string; is_muted: boolean }[]>`
      SELECT id, is_muted FROM public.forum_user_state
      WHERE forum_id = ${forumId} AND user_id = ${memberUserId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_muted).toBe(true);
  });
});
