// DB integration test for process_transfer_reversal (§14.9 / #1127 / #1424)
//
// Tests the three acceptance criteria from issue #1424:
//   1. Full reversal applies all state changes atomically.
//   2. Re-delivery of the same event is idempotent (no double-credit).
//   3. Distinct partial reversal inserts a second recovery row + additional balance debit.
//
// Runs against the real Postgres DB; gated on SUPABASE_DB_URL so it
// skips cleanly in PR CI and runs only in the nightly DB job (D-137).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_URL = process.env.SUPABASE_DB_URL;

const haveSupabase = Boolean(SUPABASE_URL && SERVICE_KEY && DB_URL);

const describeIf = haveSupabase ? describe : describe.skip;

// RUN_TAG scopes all fixture rows to this test run so concurrent runs don't collide.
const RUN_TAG = randomUUID().slice(0, 8);

interface Fixtures {
  admin: SupabaseClient;
  sql: ReturnType<typeof postgres>;
  tenantId: string;
  bookingId: string;
  commissionId: string;
  transferId: string;
  // Scenario 3 uses a second transfer/commission chain.
  tenantId2: string;
  bookingId2: string;
  commissionId2: string;
  transferId2: string;
}

let fx: Fixtures | null = null;

describeIf("process_transfer_reversal", () => {
  beforeAll(async () => {
    const admin = createClient(SUPABASE_URL!, SERVICE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const sql = postgres(DB_URL!, { max: 1, idle_timeout: 10, onnotice: () => {} });

    // ── Shared seeding helper ──────────────────────────────────────────────────

    // Resolve tier id for byo_research (has hold_period_days; seeded in all envs).
    const [tierRow] = await sql<{ id: string; hold_period_days: number }[]>`
      SELECT id, hold_period_days
      FROM   public.tier_definitions
      WHERE  code = 'byo_research'
      LIMIT  1
    `;
    if (!tierRow) throw new Error("tier_definitions not seeded — apply migrations first");

    // ── Chain 1: for tests 1 and 2 ────────────────────────────────────────────
    const TRANSFER_ID = `tr_test_${RUN_TAG}_001`;
    const slug1 = `tr-rev-${RUN_TAG}-1`;

    const { data: tenant1, error: te1 } = await admin
      .from("tenants")
      .insert({
        slug: slug1,
        display_name: "TR Test Tenant 1",
        legal_name: "TR Test Tenant 1 LLC",
        tenant_type: "sub_host",
        tier_id: tierRow.id,
      })
      .select("id")
      .single();
    if (te1 || !tenant1) throw new Error(`tenant1 insert: ${te1?.message}`);
    const tenantId = tenant1.id as string;

    const { data: booking1, error: be1 } = await admin
      .from("bookings")
      .insert({ tenant_id: tenantId, booking_type: "cruise", status: "draft" })
      .select("id")
      .single();
    if (be1 || !booking1) throw new Error(`booking1 insert: ${be1?.message}`);
    const bookingId = booking1.id as string;

    const { data: commission1, error: ce1 } = await admin
      .from("commissions")
      .insert({
        tenant_id: tenantId,
        booking_id: bookingId,
        commissionable_fare_cents: 100000,
        commission_rate: 0.10,
        platform_split_rate: 0.20,
        gross_commission_cents: 10000,
        host_booking_fee_cents: 0,
        net_commission_cents: 10000,
        platform_retained_cents: 2000,
        subhost_payable_cents: 8000,
        status: "received",
      })
      .select("id")
      .single();
    if (ce1 || !commission1) throw new Error(`commission1 insert: ${ce1?.message}`);
    const commissionId = commission1.id as string;

    const { error: pre1 } = await admin.from("payout_records").insert({
      tenant_id: tenantId,
      commission_id: commissionId,
      stripe_transfer_id: TRANSFER_ID,
      status: "paid",
      amount_cents: 10000,
    });
    if (pre1) throw new Error(`payout_records1 insert: ${pre1.message}`);

    const { error: pbe1 } = await admin.from("payout_balances").upsert({
      tenant_id: tenantId,
      available_cents: 10000,
      pending_cents: 0,
      in_transit_cents: 0,
      hold_period_days: tierRow.hold_period_days,
    });
    if (pbe1) throw new Error(`payout_balances1 upsert: ${pbe1.message}`);

    // ── Chain 2: for test 3 ───────────────────────────────────────────────────
    const TRANSFER_ID_2 = `tr_test_${RUN_TAG}_002`;
    const slug2 = `tr-rev-${RUN_TAG}-2`;

    const { data: tenant2, error: te2 } = await admin
      .from("tenants")
      .insert({
        slug: slug2,
        display_name: "TR Test Tenant 2",
        legal_name: "TR Test Tenant 2 LLC",
        tenant_type: "sub_host",
        tier_id: tierRow.id,
      })
      .select("id")
      .single();
    if (te2 || !tenant2) throw new Error(`tenant2 insert: ${te2?.message}`);
    const tenantId2 = tenant2.id as string;

    const { data: booking2, error: be2 } = await admin
      .from("bookings")
      .insert({ tenant_id: tenantId2, booking_type: "cruise", status: "draft" })
      .select("id")
      .single();
    if (be2 || !booking2) throw new Error(`booking2 insert: ${be2?.message}`);
    const bookingId2 = booking2.id as string;

    const { data: commission2, error: ce2 } = await admin
      .from("commissions")
      .insert({
        tenant_id: tenantId2,
        booking_id: bookingId2,
        commissionable_fare_cents: 50000,
        commission_rate: 0.10,
        platform_split_rate: 0.20,
        gross_commission_cents: 5000,
        host_booking_fee_cents: 0,
        net_commission_cents: 5000,
        platform_retained_cents: 1000,
        subhost_payable_cents: 4000,
        status: "received",
      })
      .select("id")
      .single();
    if (ce2 || !commission2) throw new Error(`commission2 insert: ${ce2?.message}`);
    const commissionId2 = commission2.id as string;

    const { error: pre2 } = await admin.from("payout_records").insert({
      tenant_id: tenantId2,
      commission_id: commissionId2,
      stripe_transfer_id: TRANSFER_ID_2,
      status: "paid",
      amount_cents: 5000,
    });
    if (pre2) throw new Error(`payout_records2 insert: ${pre2.message}`);

    const { error: pbe2 } = await admin.from("payout_balances").upsert({
      tenant_id: tenantId2,
      available_cents: 5000,
      pending_cents: 0,
      in_transit_cents: 0,
      hold_period_days: tierRow.hold_period_days,
    });
    if (pbe2) throw new Error(`payout_balances2 upsert: ${pbe2.message}`);

    fx = {
      admin,
      sql,
      tenantId,
      bookingId,
      commissionId,
      transferId: TRANSFER_ID,
      tenantId2,
      bookingId2,
      commissionId2,
      transferId2: TRANSFER_ID_2,
    };
  }, 60000);

  afterAll(async () => {
    if (!fx) return;
    const { admin, sql, tenantId, tenantId2 } = fx;

    try {
      // Delete in FK-dependency order for both chains.
      // Each delete is checked so a silent FK violation surfaces rather than
      // leaving fixture rows that corrupt the next nightly run.
      const tids = [tenantId, tenantId2];

      const { error: rqErr } = await admin
        .from("reconciliation_review_queue")
        .delete()
        .in("tenant_id", tids);
      if (rqErr) throw new Error(`reconciliation_review_queue cleanup: ${rqErr.message}`);

      // payout_records: covers both the original rows and recovery rows
      // (recovery rows have stripe_transfer_id IS NULL; tenant_id filter catches both).
      const { error: prErr } = await admin
        .from("payout_records")
        .delete()
        .in("tenant_id", tids);
      if (prErr) throw new Error(`payout_records cleanup: ${prErr.message}`);

      const { error: pbErr } = await admin
        .from("payout_balances")
        .delete()
        .in("tenant_id", tids);
      if (pbErr) throw new Error(`payout_balances cleanup: ${pbErr.message}`);

      const { error: commErr } = await admin
        .from("commissions")
        .delete()
        .in("tenant_id", tids);
      if (commErr) throw new Error(`commissions cleanup: ${commErr.message}`);

      const { error: bookErr } = await admin
        .from("bookings")
        .delete()
        .in("tenant_id", tids);
      if (bookErr) throw new Error(`bookings cleanup: ${bookErr.message}`);

      // audit_log has no ON DELETE CASCADE from tenants; clear before deleting tenants.
      const { error: auditErr } = await admin
        .from("audit_log")
        .delete()
        .in("tenant_id", tids);
      if (auditErr) throw new Error(`audit_log cleanup: ${auditErr.message}`);

      // Tenants are hard-delete-protected by a DB trigger (#1919/#1920 —
      // this cleanup previously went through the PostgREST admin client,
      // whose per-request transaction can't carry the SET LOCAL override,
      // so every nightly run failed here). Use the raw `sql` connection so
      // the override and the DELETE share one transaction, matching the
      // established pattern in import-promote-atomicity.test.ts (scalar
      // DELETE per row, not an array — a bare JS array interpolated in a
      // tagged template doesn't serialize to a valid array literal here).
      await sql.begin(async (tx) => {
        await tx`SET LOCAL app.allow_tenant_hard_delete = 'true'`;
        for (const tid of tids) {
          await tx`DELETE FROM public.tenants WHERE id = ${tid}`;
        }
      });
    } finally {
      await sql.end();
    }
  }, 60000);

  it("full reversal applies all state changes (return=1)", async () => {
    if (!fx) return;
    const { sql, admin, tenantId, commissionId, transferId } = fx;

    // Call the RPC as service_role (it's a SECURITY DEFINER function — the Supabase
    // client's rpc() helper goes through the PostgREST layer which runs as service_role
    // when initialized with SERVICE_KEY).
    const [result] = await sql<{ process_transfer_reversal: number }[]>`
      SELECT public.process_transfer_reversal(
        ${transferId}::TEXT,
        ${10000}::BIGINT,
        ${"evt_001_" + RUN_TAG}::TEXT
      ) AS process_transfer_reversal
    `;
    expect(result?.process_transfer_reversal).toBe(1);

    // Original payout_records row: status → 'reversed'.
    const { data: origRow } = await admin
      .from("payout_records")
      .select("status")
      .eq("stripe_transfer_id", transferId)
      .single();
    expect(origRow?.status).toBe("reversed");

    // Recovery row inserted: status='recovery', amount_cents=-10000,
    // reversal_idempotency_key contains the event id.
    const { data: recoveryRows } = await admin
      .from("payout_records")
      .select("status, amount_cents, reversal_idempotency_key")
      .eq("tenant_id", tenantId)
      .eq("status", "recovery");
    expect(recoveryRows).toHaveLength(1);
    expect(Number(recoveryRows![0]!.amount_cents)).toBe(-10000);
    expect(recoveryRows![0]!.reversal_idempotency_key).toContain("evt_001_" + RUN_TAG);

    // payout_balances: available_cents debited by 10000 (10000 → 0).
    const { data: bal } = await admin
      .from("payout_balances")
      .select("available_cents")
      .eq("tenant_id", tenantId)
      .single();
    expect(Number(bal?.available_cents)).toBe(0);

    // commissions: status → 'disputed'.
    const { data: comm } = await admin
      .from("commissions")
      .select("status")
      .eq("id", commissionId)
      .single();
    expect(comm?.status).toBe("disputed");

    // reconciliation_review_queue: one clawback row opened.
    const { data: queueRows } = await admin
      .from("reconciliation_review_queue")
      .select("status, variance_cents")
      .eq("commission_id", commissionId);
    expect(queueRows).toHaveLength(1);
    expect(queueRows![0]!.status).toBe("clawback");
    expect(Number(queueRows![0]!.variance_cents)).toBe(10000);
  });

  it("re-delivery of same event is idempotent (return=0, no second recovery row)", async () => {
    // Depends on test 1 having already applied the reversal.
    // The same (transferId, eventId) pair must be a no-op.
    if (!fx) return;
    const { sql, admin, tenantId, commissionId } = fx;

    const [result] = await sql<{ process_transfer_reversal: number }[]>`
      SELECT public.process_transfer_reversal(
        ${fx.transferId}::TEXT,
        ${10000}::BIGINT,
        ${"evt_001_" + RUN_TAG}::TEXT
      ) AS process_transfer_reversal
    `;
    // The idempotency anchor (ON CONFLICT DO NOTHING on reversal_idempotency_key)
    // must cause the RPC to return 0.
    expect(result?.process_transfer_reversal).toBe(0);

    // Still only one recovery row — no duplicate inserted.
    const { data: recoveryRows } = await admin
      .from("payout_records")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("status", "recovery");
    expect(recoveryRows).toHaveLength(1);

    // Balance unchanged: still 0 (the second call must not debit again).
    const { data: bal } = await admin
      .from("payout_balances")
      .select("available_cents")
      .eq("tenant_id", tenantId)
      .single();
    expect(Number(bal?.available_cents)).toBe(0);

    // reconciliation_review_queue: still exactly one row (no duplicate).
    const { data: queueRows } = await admin
      .from("reconciliation_review_queue")
      .select("id")
      .eq("commission_id", commissionId);
    expect(queueRows).toHaveLength(1);
  });

  it("distinct partial reversals each insert a recovery row and debit the balance (return=1 each)", async () => {
    if (!fx) return;
    const { sql, admin, tenantId2, commissionId2, transferId2 } = fx;

    // First partial: 2000 cents.
    const [r1] = await sql<{ process_transfer_reversal: number }[]>`
      SELECT public.process_transfer_reversal(
        ${transferId2}::TEXT,
        ${2000}::BIGINT,
        ${"evt_002_" + RUN_TAG}::TEXT
      ) AS process_transfer_reversal
    `;
    expect(r1?.process_transfer_reversal).toBe(1);

    // Second partial: 3000 cents (different event id → different idempotency key).
    const [r2] = await sql<{ process_transfer_reversal: number }[]>`
      SELECT public.process_transfer_reversal(
        ${transferId2}::TEXT,
        ${3000}::BIGINT,
        ${"evt_003_" + RUN_TAG}::TEXT
      ) AS process_transfer_reversal
    `;
    expect(r2?.process_transfer_reversal).toBe(1);

    // Two recovery rows exist (one per distinct event).
    const { data: recoveryRows } = await admin
      .from("payout_records")
      .select("amount_cents")
      .eq("tenant_id", tenantId2)
      .eq("status", "recovery");
    expect(recoveryRows).toHaveLength(2);
    const amounts = recoveryRows!.map((r) => Number(r.amount_cents)).sort((a, b) => a - b);
    expect(amounts).toEqual([-3000, -2000]);

    // Balance: 5000 - 2000 - 3000 = 0.
    const { data: bal } = await admin
      .from("payout_balances")
      .select("available_cents")
      .eq("tenant_id", tenantId2)
      .single();
    expect(Number(bal?.available_cents)).toBe(0);

    // Two clawback review rows (one per partial).
    const { data: queueRows } = await admin
      .from("reconciliation_review_queue")
      .select("status, variance_cents")
      .eq("commission_id", commissionId2);
    expect(queueRows).toHaveLength(2);
    expect(queueRows!.every((r) => r.status === "clawback")).toBe(true);
    const variances = queueRows!.map((r) => Number(r.variance_cents)).sort((a, b) => a - b);
    expect(variances).toEqual([2000, 3000]);
  });
});
