/**
 * §30.8 BP30 live-dispatch (Tier 3) — retention-purge boundary probe.
 *
 * Handlers that DELETE rows are the highest-stakes Inngest functions
 * on the platform. Wrong cutoff = data loss or compliance failure.
 * This suite seeds rows on both sides of each handler's retention
 * boundary and asserts the handler deletes ONLY the past-cutoff rows.
 *
 *   1. bookingCommissionRetentionPurge — 7-year cutoff on
 *      bookings.sailing_date; commissions cascade with the booking.
 *      Disputes ('open' / 'under_review') preserve the booking.
 *
 *   2. forensicsLogPurgeCron — straightforward
 *      `DELETE FROM forensics_log WHERE purge_after < NOW() AND
 *      legal_hold = false`. Legal-hold rows are preserved indefinitely.
 *
 *   3. userDataPurgeAfterGrace — event-triggered; takes purge_at in
 *      event.data and refuses if Date.now() < purge_at. Testable as
 *      a deferred / executed branch pair.
 *
 * Each test cleans up its own seed rows so tests can re-run cleanly.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { TEST_ANON_JWT, TEST_SERVICE_ROLE_JWT } from "./_test-jwt-fixtures";

const haveTier2 = Boolean(process.env.SUPABASE_DB_URL);
const describeIf = haveTier2 ? describe : describe.skip;

if (haveTier2) {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= TEST_ANON_JWT;
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= TEST_SERVICE_ROLE_JWT;
  process.env.INNGEST_EVENT_KEY ??= "tier2-test-eventkey";
  // Forensics encryption — purge cron doesn't decrypt but module-level
  // imports may chain to env.ts which reads this. Synthetic 32-byte base64.
  process.env.FORENSICS_ENCRYPTION_KEY_CURRENT ??= "p4zfG+1D1S1KXF33Z9wqwfybOnOVGWe4L1dmRDmVk7s=";
  process.env.FORENSICS_ENCRYPTION_KEY_ID_CURRENT ??= "forensics-v1";
}

import { invokeInngestHandler } from "./_inngest-invoke";
import { inngest } from "@/inngest/client";
import { bookingCommissionRetentionPurge } from "@/inngest/booking-commission-retention-purge";
import { forensicsLogPurgeCron } from "@/inngest/forensics-log-purge-cron";
import { userDataPurgeAfterGrace } from "@/inngest/user-data-purge-after-grace";

(inngest as unknown as { send: (e: unknown) => Promise<unknown> }).send = async () => ({ ids: [] });

const SUPABASE_DB_URL =
  process.env.SUPABASE_DB_URL ?? `postgresql://${process.env.USER}@localhost:5432/atc_main_test`;
const sql = postgres(SUPABASE_DB_URL, { max: 2, idle_timeout: 5, onnotice: () => {} });

const TENANT = process.env.TEST_AUTH_BYPASS_TENANT_ID ?? "22222222-0000-0000-0000-0000000000a1";

// Marker UUIDs so each test cleans up only its own rows.
const OLD_BOOKING_ID    = "ee100000-0000-0000-0000-0000000000e1";
const FRESH_BOOKING_ID  = "ee100000-0000-0000-0000-0000000000e2";
const DISPUTED_BOOKING_ID = "ee100000-0000-0000-0000-0000000000e3";
const PURGED_FORENSICS_ID = "ee200000-0000-0000-0000-0000000000f1";
const KEPT_FORENSICS_ID   = "ee200000-0000-0000-0000-0000000000f2";
const HOLD_FORENSICS_ID   = "ee200000-0000-0000-0000-0000000000f3";

afterAll(async () => { await sql.end(); });

beforeEach(async () => {
  await sql`DELETE FROM public.commissions WHERE booking_id IN (${OLD_BOOKING_ID}::uuid, ${FRESH_BOOKING_ID}::uuid, ${DISPUTED_BOOKING_ID}::uuid)`;
  await sql`DELETE FROM public.bookings    WHERE id          IN (${OLD_BOOKING_ID}::uuid, ${FRESH_BOOKING_ID}::uuid, ${DISPUTED_BOOKING_ID}::uuid)`;
  await sql`DELETE FROM public.forensics_log WHERE id        IN (${PURGED_FORENSICS_ID}::uuid, ${KEPT_FORENSICS_ID}::uuid, ${HOLD_FORENSICS_ID}::uuid)`;
});

// ── bookingCommissionRetentionPurge ─────────────────────────────────────

describeIf("BP30 Tier 3 — bookingCommissionRetentionPurge boundary", () => {
  it("purges bookings >7 years past sailing_date AND preserves recent + disputed bookings", async () => {
    const eightYearsAgo = new Date(Date.now() - 8 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const twoYearsAgo   = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await sql`
      INSERT INTO public.bookings (id, tenant_id, booking_type, sailing_date, status, currency)
      VALUES
        (${OLD_BOOKING_ID}::uuid,      ${TENANT}::uuid, 'cruise', ${eightYearsAgo}, 'completed', 'USD'),
        (${FRESH_BOOKING_ID}::uuid,    ${TENANT}::uuid, 'cruise', ${twoYearsAgo},   'completed', 'USD'),
        (${DISPUTED_BOOKING_ID}::uuid, ${TENANT}::uuid, 'cruise', ${eightYearsAgo}, 'completed', 'USD')
    `;
    // Disputed-booking has a commission row with dispute_status='open' —
    // the handler must preserve it.
    await sql`
      INSERT INTO public.commissions (
        booking_id, tenant_id, commissionable_fare_cents,
        commission_rate, platform_split_rate,
        gross_commission_cents, net_commission_cents,
        platform_retained_cents, subhost_payable_cents,
        currency, dispute_status
      ) VALUES (
        ${DISPUTED_BOOKING_ID}::uuid, ${TENANT}::uuid, 100000,
        0.1, 0.0,
        10000, 10000, 0, 0,
        'USD', 'open'
      )
    `;

    await invokeInngestHandler(bookingCommissionRetentionPurge, { name: "cron", data: {} });

    const remaining = await sql<Array<{ id: string }>>`
      SELECT id FROM public.bookings WHERE id IN
        (${OLD_BOOKING_ID}::uuid, ${FRESH_BOOKING_ID}::uuid, ${DISPUTED_BOOKING_ID}::uuid)
    `;
    const ids = new Set(remaining.map((r) => r.id));
    expect(ids.has(OLD_BOOKING_ID), "old non-disputed booking should be deleted").toBe(false);
    expect(ids.has(FRESH_BOOKING_ID), "recent booking should be preserved").toBe(true);
    expect(ids.has(DISPUTED_BOOKING_ID), "disputed booking should be preserved despite age").toBe(true);
  });
});

// ── forensicsLogPurgeCron ───────────────────────────────────────────────

describeIf("BP30 Tier 3 — forensicsLogPurgeCron boundary", () => {
  it("deletes rows past purge_after AND preserves rows with legal_hold=true", async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const tomorrow  = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    // bytea literal — empty single-byte placeholder satisfies NOT NULL.
    const emptyPayload = "\\x00";

    await sql`
      INSERT INTO public.forensics_log
        (id, tenant_id, snapshot_type, reason, encrypted_payload, encryption_key_id, purge_after, legal_hold)
      VALUES
        (${PURGED_FORENSICS_ID}::uuid, ${TENANT}::uuid, 'security_incident', 'test', ${emptyPayload}, 'forensics-v1', ${yesterday}, false),
        (${KEPT_FORENSICS_ID}::uuid,   ${TENANT}::uuid, 'security_incident', 'test', ${emptyPayload}, 'forensics-v1', ${tomorrow},  false),
        (${HOLD_FORENSICS_ID}::uuid,   ${TENANT}::uuid, 'security_incident', 'test', ${emptyPayload}, 'forensics-v1', ${yesterday}, true)
    `;

    await invokeInngestHandler(forensicsLogPurgeCron, { name: "cron", data: {} });

    const remaining = await sql<Array<{ id: string }>>`
      SELECT id FROM public.forensics_log WHERE id IN
        (${PURGED_FORENSICS_ID}::uuid, ${KEPT_FORENSICS_ID}::uuid, ${HOLD_FORENSICS_ID}::uuid)
    `;
    const ids = new Set(remaining.map((r) => r.id));
    expect(ids.has(PURGED_FORENSICS_ID), "past purge_after + no hold should be deleted").toBe(false);
    expect(ids.has(KEPT_FORENSICS_ID),   "future purge_after should be preserved").toBe(true);
    expect(ids.has(HOLD_FORENSICS_ID),   "legal_hold=true should be preserved indefinitely").toBe(true);
  });
});

// ── userDataPurgeAfterGrace ─────────────────────────────────────────────
//
// Event-triggered. Tests the grace-window short-circuit: when purge_at
// is in the future, the handler defers; only past-purge_at events
// actually purge. We test BOTH branches without seeding a full user
// fixture (the full purge integration is covered by lib/privacy/purge-
// user-data unit tests).

describeIf("BP30 Tier 3 — userDataPurgeAfterGrace grace-window short-circuit", () => {
  // The handler's Zod schema (#742 / PR #937) refuses payloads where
  // purge_at is less than 25 days after deleted_at — a forged event must
  // not shrink the CCPA grace window. Fixtures therefore date deleted_at
  // 30 days back so both branches clear the refine and exercise the
  // sleepUntil short-circuit itself, not payload validation.
  it("defers (returns deferred) when purge_at is in the future", async () => {
    const futurePurgeAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { result } = await invokeInngestHandler<{ deferred?: boolean; status?: string }>(
      userDataPurgeAfterGrace,
      {
        name: "user.data_purge_scheduled",
        data: {
          auth_user_id: "00000000-0000-4000-8000-00000000d001",
          user_id:      "00000000-0000-4000-8000-00000000d002",
          deleted_at:   new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
          purge_at:     futurePurgeAt,
        },
      },
    );
    // Handler returns either `{ deferred: true, ... }` or `{ status: 'deferred', ... }`.
    expect(Boolean(result.deferred) || result.status === "deferred").toBe(true);
  });

  it("does not defer (runs the purge path) when purge_at is in the past", async () => {
    const pastPurgeAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { result } = await invokeInngestHandler<{ deferred?: boolean; skipped?: boolean; reason?: string }>(
      userDataPurgeAfterGrace,
      {
        name: "user.data_purge_scheduled",
        data: {
          auth_user_id: "00000000-0000-4000-8000-00000000d001",
          user_id:      "00000000-0000-4000-8000-00000000d002",
          deleted_at:   new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
          purge_at:     pastPurgeAt,
        },
      },
    );
    // Past wake → sleepUntil no-ops → handler proceeds, finds no such user
    // (d002 isn't seeded), returns a bare { skipped: true }. Asserting
    // reason is undefined distinguishes this from the Zod invalid_payload
    // skip, which would mean the purge path never ran at all.
    expect(Boolean(result.deferred)).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});
