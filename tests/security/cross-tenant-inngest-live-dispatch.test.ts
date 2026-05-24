/**
 * §30.8 — Cross-tenant Inngest probe (LIVE-DISPATCH).
 *
 * Companion to cross-tenant-inngest-probe.test.ts (static). The static
 * probe asserts shape contracts (which authority surface tokens appear
 * in each handler's source); this live-dispatch probe asserts runtime
 * behaviour: when an event fires, the handler actually executes against
 * the DB, writes the audit row (for platform-admin handlers), and
 * respects tenant scoping.
 *
 * Run requirement: local Postgres + Tier-2 fixtures + Tier-2.5 PostgREST
 * (the audit-log path goes through the Supabase JS client). See
 * docs/testing/e2e-local-setup.md.
 *
 * Scope: proof-of-harness over 2 representative handlers:
 *   1. anonymousChatCounterCleanup — service-role cron, no audit wrapper,
 *      asserts the deletion actually happens with the right `count`.
 *   2. abuseOverrideExpirySweep — platform-admin wrapped, asserts one
 *      audit_log row appears with the expected reason + operation.
 *
 * Adding coverage for more handlers is a per-handler small ask: import,
 * invoke, assert. The harness (_inngest-invoke.ts) is reusable.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";

// Gated: requires the Tier-2 + Tier-2.5 local stack (Postgres + PostgREST
// + proxy + fixtures). When SUPABASE_DB_URL is unset, skip — same gate
// the integration tests use, so `pnpm test` with no env stays green.
const haveTier2 = Boolean(process.env.SUPABASE_DB_URL);
const describeIf = haveTier2 ? describe : describe.skip;

// The Inngest handlers we invoke use createServiceRoleClient(), which
// reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY at the call
// site. The Tier-2.5 PostgREST proxy + signed JWTs make these resolvable
// against the local DB. Set BEFORE importing handlers so module-level
// createClient() calls see them. Only set when the Tier-2 gate is open
// so we don't poison sibling test files that expect these unset.
if (haveTier2) {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??=
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InRpZXIyLWxvY2FsIn0.Pz-8BVTsRIUC81JWFUXQyvCjid981wZGKiag9Z2GF34";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??=
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoidGllcjItbG9jYWwifQ.88tFBcM9_intifembBjlhAE04uCnr0M2GbV_rTuxH3o";
  process.env.INNGEST_EVENT_KEY ??= "tier2-test-eventkey";
}

import { invokeInngestHandler } from "./_inngest-invoke";
import { inngest } from "@/inngest/client";
import { anonymousChatCounterCleanup } from "@/inngest/anonymous-chat-counter-cleanup";
import { abuseOverrideExpirySweep } from "@/inngest/abuse-override-expiry-sweep";

// Stub inngest.send so handlers that re-dispatch events (e.g.
// abuseOverrideExpirySweep firing tenant.subscription_changed) don't
// try to reach the real Inngest API.
const sentEvents: Array<{ name: string; data: unknown }> = [];
(inngest as unknown as { send: (e: unknown) => Promise<unknown> }).send = async (e) => {
  if (Array.isArray(e)) for (const x of e) sentEvents.push(x as { name: string; data: unknown });
  else sentEvents.push(e as { name: string; data: unknown });
  return { ids: [] };
};

const SUPABASE_DB_URL =
  process.env.SUPABASE_DB_URL ?? `postgresql://${process.env.USER}@localhost:5432/atc_main_test`;
const sql = postgres(SUPABASE_DB_URL, { max: 2, idle_timeout: 5, onnotice: () => {} });

const TENANT = process.env.TEST_AUTH_BYPASS_TENANT_ID ?? "22222222-0000-0000-0000-0000000000a1";
const OLD_IDENT = "test-bp30-old";
const FRESH_IDENT = "test-bp30-fresh";
const OVERRIDE_ID = "ff000000-0000-0000-0000-0000000000ff";

afterAll(async () => { await sql.end(); });

beforeEach(async () => {
  sentEvents.length = 0;
  await sql`DELETE FROM public.anonymous_chat_counters WHERE identifier_value IN (${OLD_IDENT}, ${FRESH_IDENT})`;
  await sql`DELETE FROM public.tenant_usage_overrides WHERE id = ${OVERRIDE_ID}::uuid`;
});

describeIf("BP30 live-dispatch —anonymousChatCounterCleanup", () => {
  it("deletes anonymous_chat_counters rows older than 7 days", async () => {
    // Seed: one row 10 days old (should be deleted), one row 1 day old (should survive).
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    await sql`
      INSERT INTO public.anonymous_chat_counters
        (identifier_type, identifier_value, tenant_id, current_count, last_message_at, first_message_at)
      VALUES
        ('ip', ${OLD_IDENT}, ${TENANT}::uuid, 1, ${tenDaysAgo}, ${tenDaysAgo}),
        ('ip', ${FRESH_IDENT}, ${TENANT}::uuid, 1, ${oneDayAgo}, ${oneDayAgo})
    `;

    const { result } = await invokeInngestHandler<{ deleted: number; error?: string }>(
      anonymousChatCounterCleanup,
      { name: "cron", data: {} },
    );
    expect(result.error).toBeUndefined();
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    // Old row gone; fresh row intact.
    const oldStill = await sql`SELECT 1 FROM public.anonymous_chat_counters WHERE identifier_value = ${OLD_IDENT}`;
    expect(oldStill).toHaveLength(0);
    const freshStill = await sql`SELECT 1 FROM public.anonymous_chat_counters WHERE identifier_value = ${FRESH_IDENT}`;
    expect(freshStill).toHaveLength(1);
  });
});

describeIf("BP30 live-dispatch —abuseOverrideExpirySweep", () => {
  it("flips expiry_notified_at on overdue overrides and writes ONE audit_log row", async () => {
    // Seed an expired-but-unnotified override. approved_by_user_id FKs to
    // public.users; we use the Tier-2 fixture user id from the seed script.
    const APPROVER = process.env.TEST_AUTH_BYPASS_PUBLIC_USER_ID
      ?? "b0000000-0000-0000-0000-0000000000b1";
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await sql`
      INSERT INTO public.tenant_usage_overrides
        (id, tenant_id, dimension, tier_override, threshold_value,
         effective_from, effective_to, reason, approved_by_user_id)
      VALUES (
        ${OVERRIDE_ID}::uuid, ${TENANT}::uuid, 'chat_volume', 'soft1', 0,
        '2026-01-01', ${yesterday}, 'bp30 live-dispatch test', ${APPROVER}::uuid
      )
    `;

    // Capture audit_log baseline so we can assert "exactly one new row".
    // writeAuditRow stores reason in the `action` column as
    // "platformAdmin.<reason>" — match that shape.
    const beforeAudit = await sql<Array<{ count: string }>>`
      SELECT count(*)::text FROM public.audit_log WHERE action = 'platformAdmin.abuse_override_revoke'
    `;
    const beforeCount = Number(beforeAudit[0]!.count);

    const { result } = await invokeInngestHandler<{ expired_overrides: number; tenants_recomputed: number }>(
      abuseOverrideExpirySweep,
      { name: "cron", data: {} },
    );

    expect(result.expired_overrides).toBeGreaterThanOrEqual(1);

    const afterAudit = await sql<Array<{ count: string }>>`
      SELECT count(*)::text FROM public.audit_log WHERE action = 'platformAdmin.abuse_override_revoke'
    `;
    const afterCount = Number(afterAudit[0]!.count);
    expect(afterCount - beforeCount).toBe(1);

    // The override row's expiry_notified_at is now set.
    const row = await sql<Array<{ expiry_notified_at: string | null }>>`
      SELECT expiry_notified_at FROM public.tenant_usage_overrides WHERE id = ${OVERRIDE_ID}::uuid
    `;
    expect(row[0]!.expiry_notified_at).not.toBeNull();
  });
});
