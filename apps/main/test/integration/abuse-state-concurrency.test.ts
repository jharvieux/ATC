// #2112 — real Postgres concurrency proof for usage counters and transition
// outbox rows. Unit mocks cannot demonstrate row-lock serialization.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const dbUrl = process.env.SUPABASE_DB_URL;
const describeIf = dbUrl ? describe : describe.skip;
const K = 10;
const RUN_TAG = `abuse-${randomUUID().slice(0, 8)}`;

let sql: ReturnType<typeof postgres>;
let tenantId: string;
let otherTenantId: string;
let period: string;

function monthRange(): string {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return `[${start},${end})`;
}

function previousMonthRange(): string {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  return `[${start},${end})`;
}

async function eventCount(dimension: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM public.usage_limit_events
    WHERE tenant_id = ${tenantId}::uuid
      AND dimension = ${dimension}
      AND resolution_action = 'state_transition'
  `;
  return row?.n ?? 0;
}

async function evaluationCount(dimension: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM public.usage_limit_state_evaluations
    WHERE tenant_id = ${tenantId}::uuid
      AND dimension = ${dimension}
      AND pending
  `;
  return row?.n ?? 0;
}

describeIf("abuse usage/state RPC concurrency (DB integration)", () => {
  beforeAll(async () => {
    sql = postgres(dbUrl!, { max: K + 2, idle_timeout: 20, onnotice: () => {} });
    period = monthRange();
    const tier = await sql<{ id: string }[]>`
      SELECT id FROM public.tier_definitions WHERE code = 'byo_research' LIMIT 1
    `;
    if (!tier[0]) throw new Error("tier_definitions not seeded — apply migrations first");

    const tenants = await sql<{ id: string }[]>`
      INSERT INTO public.tenants (slug, display_name, legal_name, tenant_type, status, tier_id)
      VALUES
        (${RUN_TAG}, ${RUN_TAG}, 'Abuse Concurrency LLC', 'byo_host', 'active', ${tier[0].id}),
        (${`${RUN_TAG}-other`}, ${`${RUN_TAG}-other`}, 'Other Tenant LLC', 'byo_host', 'active', ${tier[0].id})
      RETURNING id
    `;
    if (!tenants[0] || !tenants[1]) throw new Error("tenant fixture insert returned no rows");
    tenantId = tenants[0].id;
    otherTenantId = tenants[1].id;

    await sql`
      INSERT INTO public.tenant_usage_metrics (tenant_id, billing_period)
      VALUES (${tenantId}::uuid, ${period}::daterange), (${otherTenantId}::uuid, ${period}::daterange)
    `;
  }, 60000);

  afterAll(async () => {
    if (!sql) return;
    try {
      await sql`DELETE FROM public.usage_limit_events WHERE tenant_id IN (${tenantId}::uuid, ${otherTenantId}::uuid)`;
      await sql`DELETE FROM public.tenant_rag_cap_events WHERE tenant_id IN (${tenantId}::uuid, ${otherTenantId}::uuid)`;
      await sql`DELETE FROM public.tenant_rag_quotas WHERE tenant_id IN (${tenantId}::uuid, ${otherTenantId}::uuid)`;
      await sql`DELETE FROM public.tenant_usage_metrics WHERE tenant_id IN (${tenantId}::uuid, ${otherTenantId}::uuid)`;
      await sql.begin(async (tx) => {
        await tx`SET LOCAL app.allow_tenant_hard_delete = 'true'`;
        await tx`DELETE FROM public.tenants WHERE id IN (${tenantId}::uuid, ${otherTenantId}::uuid)`;
      });
    } finally {
      await sql.end();
    }
  }, 60000);

  it("serializes chat/email/group threshold crossings into one event each", async () => {
    const dimensions = [
      { name: "chat_volume", soft1: 100 },
      { name: "email_volume", soft1: 5 },
      { name: "group_invite", soft1: 100 },
    ] as const;

    await sql`
      UPDATE public.tenant_usage_metrics
      SET chat_messages_count = 99,
          email_sent_count = 4,
          email_sent_today = 4,
          email_sent_day_ref = CURRENT_DATE,
          group_invitees_count = 99,
          chat_volume_limit_state = 'ok',
          email_volume_limit_state = 'ok',
          group_invite_limit_state = 'ok'
      WHERE tenant_id = ${tenantId}::uuid AND billing_period = ${period}::daterange
    `;

    for (const dimension of dimensions) {
      await Promise.all(Array.from({ length: K }, async () => {
        await sql`
        SELECT public.increment_tenant_usage_counter(
          ${tenantId}::uuid,
          ${period}::daterange,
          ${dimension.name},
          1
        )
        `;
        await sql`SELECT * FROM public.advance_tenant_usage_state(
          ${tenantId}::uuid,
          ${period}::daterange,
          ${dimension.name},
          ${dimension.soft1},
          1000,
          2000,
          false,
          NULL
        )`;
      }));
      expect(await eventCount(dimension.name)).toBe(1);
      expect(await evaluationCount(dimension.name)).toBe(0);
    }

    const [row] = await sql<{
      chat_messages_count: number;
      email_sent_count: number;
      email_sent_today: number;
      group_invitees_count: number;
    }[]>`
      SELECT chat_messages_count, email_sent_count, email_sent_today, group_invitees_count
      FROM public.tenant_usage_metrics
      WHERE tenant_id = ${tenantId}::uuid AND billing_period = ${period}::daterange
    `;
    expect(row).toMatchObject({
      chat_messages_count: 99 + K,
      email_sent_count: 4 + K,
      email_sent_today: 4 + K,
      group_invitees_count: 99 + K,
    });

    const [other] = await sql<{ total: number }[]>`
      SELECT (chat_messages_count + email_sent_count + group_invitees_count)::int AS total
      FROM public.tenant_usage_metrics
      WHERE tenant_id = ${otherTenantId}::uuid AND billing_period = ${period}::daterange
    `;
    expect(other?.total).toBe(0);
  });

  it("keeps old and new period crash markers until each period recovers", async () => {
    const oldPeriod = previousMonthRange();
    const before = await eventCount("chat_volume");
    await sql`
      INSERT INTO public.tenant_usage_metrics (
        tenant_id, billing_period, chat_messages_count, chat_volume_limit_state
      ) VALUES (${tenantId}::uuid, ${oldPeriod}::daterange, 4, 'ok')
      ON CONFLICT (tenant_id, billing_period) DO UPDATE SET
        chat_messages_count = 4,
        chat_volume_limit_state = 'ok'
    `;
    await sql`
      UPDATE public.tenant_usage_metrics
      SET chat_messages_count = 4, chat_volume_limit_state = 'ok'
      WHERE tenant_id = ${tenantId}::uuid AND billing_period = ${period}::daterange
    `;

    await sql`SELECT public.increment_tenant_usage_counter(
      ${tenantId}::uuid, ${oldPeriod}::daterange, 'chat_volume', 1
    )`;
    await sql`SELECT public.increment_tenant_usage_counter(
      ${tenantId}::uuid, ${period}::daterange, 'chat_volume', 1
    )`;

    const markers = await sql<{ billing_period: string }[]>`
      SELECT billing_period::text
      FROM public.usage_limit_state_evaluations
      WHERE tenant_id = ${tenantId}::uuid AND dimension = 'chat_volume'
      ORDER BY lower(billing_period)
    `;
    expect(markers.map((row) => row.billing_period)).toEqual([oldPeriod, period]);

    for (const recoveryPeriod of [oldPeriod, period]) {
      await sql`SELECT * FROM public.advance_tenant_usage_state(
        ${tenantId}::uuid, ${recoveryPeriod}::daterange, 'chat_volume', 5, 10, 20, false, NULL
      )`;
    }
    expect(await eventCount("chat_volume")).toBe(before + 2);
    expect(await evaluationCount("chat_volume")).toBe(0);
  });

  it("creates one monthly logical transition/outbox under concurrent threshold checks", async () => {
    await sql`
      UPDATE public.tenant_usage_metrics
      SET ai_cost_cents = 99, ai_cost_limit_state = 'ok'
      WHERE tenant_id = ${tenantId}::uuid AND billing_period = ${period}::daterange
    `;

    await Promise.all(Array.from({ length: K }, async () => {
      await sql`SELECT public.increment_tenant_ai_cost(${tenantId}::uuid, ${period}::daterange, 1)`;
      await sql`SELECT * FROM public.advance_tenant_usage_state(
        ${tenantId}::uuid, ${period}::daterange, 'ai_cost', 100, 1000, 2000, false, NULL
      )`;
    }));

    const [row] = await sql<{ ai_cost_cents: string; ai_cost_limit_state: string }[]>`
      SELECT ai_cost_cents::text, ai_cost_limit_state
      FROM public.tenant_usage_metrics
      WHERE tenant_id = ${tenantId}::uuid AND billing_period = ${period}::daterange
    `;
    expect(row).toEqual({ ai_cost_cents: String(99 + K), ai_cost_limit_state: "soft1" });
    expect(await eventCount("ai_cost")).toBe(1);
    expect(await evaluationCount("ai_cost")).toBe(0);
  });

  it("retains a durable evaluation marker after a counter-only crash window", async () => {
    const before = await eventCount("email_volume");
    await sql`
      DELETE FROM public.usage_limit_state_evaluations
      WHERE tenant_id = ${tenantId}::uuid
        AND dimension = 'email_volume'
        AND billing_period = ${period}::daterange
    `;
    await sql`
      UPDATE public.tenant_usage_metrics
      SET email_sent_today = 4,
          email_sent_day_ref = CURRENT_DATE,
          email_volume_limit_state = 'ok'
      WHERE tenant_id = ${tenantId}::uuid AND billing_period = ${period}::daterange
    `;

    await sql`SELECT public.increment_tenant_usage_counter(
      ${tenantId}::uuid, ${period}::daterange, 'email_volume', 1
    )`;
    expect(await evaluationCount("email_volume")).toBe(1);

    await sql`SELECT * FROM public.advance_tenant_usage_state(
      ${tenantId}::uuid, ${period}::daterange, 'email_volume', 5, 10, 20, false, NULL
    )`;

    const [row] = await sql<{ email_volume_limit_state: string }[]>`
      SELECT email_volume_limit_state
      FROM public.tenant_usage_metrics
      WHERE tenant_id = ${tenantId}::uuid AND billing_period = ${period}::daterange
    `;
    expect(row?.email_volume_limit_state).toBe("soft1");
    expect(await eventCount("email_volume")).toBe(before + 1);
    expect(await evaluationCount("email_volume")).toBe(0);
  });

  it("inherits monthly email state across same-day and new-day markers", async () => {
    const rangeStart = new Date(`${period.slice(1, 11)}T00:00:00.000Z`);
    const sameDay = new Date(rangeStart.getTime() + 4 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const newDay = new Date(rangeStart.getTime() + 5 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const before = await eventCount("email_volume");
    await sql`
      DELETE FROM public.usage_limit_state_evaluations
      WHERE tenant_id = ${tenantId}::uuid
        AND dimension = 'email_volume'
        AND billing_period = ${period}::daterange
    `;
    await sql`
      UPDATE public.tenant_usage_metrics
      SET email_sent_count = 5,
          email_sent_today = 5,
          email_sent_day_ref = ${sameDay}::date,
          email_volume_limit_state = 'soft1'
      WHERE tenant_id = ${tenantId}::uuid AND billing_period = ${period}::daterange
    `;

    await sql`SELECT public.increment_tenant_usage_counter(
      ${tenantId}::uuid,
      ${period}::daterange,
      'email_volume',
      1,
      ${`${sameDay}T12:00:00.000Z`}::timestamptz
    )`;
    let [marker] = await sql<{
      evaluation_day: string;
      evaluation_value: string;
      evaluated_state: string;
      pending: boolean;
    }[]>`
      SELECT evaluation_day::text, evaluation_value::text, evaluated_state, pending
      FROM public.usage_limit_state_evaluations
      WHERE tenant_id = ${tenantId}::uuid
        AND dimension = 'email_volume'
        AND billing_period = ${period}::daterange
        AND evaluation_day = ${sameDay}::date
    `;
    expect(marker).toEqual({
      evaluation_day: sameDay,
      evaluation_value: "6",
      evaluated_state: "soft1",
      pending: true,
    });

    await sql`SELECT * FROM public.advance_tenant_usage_state(
      ${tenantId}::uuid, ${period}::daterange, 'email_volume', 5, 10, 20,
      false, NULL, ${sameDay}::date
    )`;
    expect(await eventCount("email_volume")).toBe(before);

    await sql`SELECT public.increment_tenant_usage_counter(
      ${tenantId}::uuid,
      ${period}::daterange,
      'email_volume',
      1,
      ${`${newDay}T00:00:00.001Z`}::timestamptz
    )`;
    const [metrics] = await sql<{
      email_sent_today: number;
      email_sent_day_ref: string;
      email_volume_limit_state: string;
    }[]>`
      SELECT email_sent_today, email_sent_day_ref::text, email_volume_limit_state
      FROM public.tenant_usage_metrics
      WHERE tenant_id = ${tenantId}::uuid AND billing_period = ${period}::daterange
    `;
    expect(metrics).toEqual({
      email_sent_today: 1,
      email_sent_day_ref: newDay,
      email_volume_limit_state: "soft1",
    });

    [marker] = await sql<{
      evaluation_day: string;
      evaluation_value: string;
      evaluated_state: string;
      pending: boolean;
    }[]>`
      SELECT evaluation_day::text, evaluation_value::text, evaluated_state, pending
      FROM public.usage_limit_state_evaluations
      WHERE tenant_id = ${tenantId}::uuid
        AND dimension = 'email_volume'
        AND billing_period = ${period}::daterange
        AND evaluation_day = ${newDay}::date
    `;
    expect(marker).toEqual({
      evaluation_day: newDay,
      evaluation_value: "1",
      evaluated_state: "soft1",
      pending: true,
    });

    await sql`SELECT * FROM public.advance_tenant_usage_state(
      ${tenantId}::uuid, ${period}::daterange, 'email_volume', 5, 10, 20,
      false, NULL, ${newDay}::date
    )`;
    expect(await eventCount("email_volume")).toBe(before);
    expect(await evaluationCount("email_volume")).toBe(0);
  });

  it("recovers both sides of UTC midnight without coalescing daily email state", async () => {
    const rangeStart = new Date(`${period.slice(1, 11)}T00:00:00.000Z`);
    const oldDay = new Date(rangeStart.getTime() + 10 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const newDay = new Date(rangeStart.getTime() + 11 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    const before = await eventCount("email_volume");
    await sql`
      DELETE FROM public.usage_limit_state_evaluations
      WHERE tenant_id = ${tenantId}::uuid
        AND dimension = 'email_volume'
        AND billing_period = ${period}::daterange
    `;
    await sql`
      UPDATE public.tenant_usage_metrics
      SET email_sent_count = 4,
          email_sent_today = 4,
          email_sent_day_ref = ${oldDay}::date,
          email_volume_limit_state = 'ok',
          email_volume_state_changed_at = NULL
      WHERE tenant_id = ${tenantId}::uuid AND billing_period = ${period}::daterange
    `;

    await sql`SELECT public.increment_tenant_usage_counter(
      ${tenantId}::uuid,
      ${period}::daterange,
      'email_volume',
      1,
      ${`${oldDay}T23:59:59.999Z`}::timestamptz
    )`;
    await sql`SELECT public.increment_tenant_usage_counter(
      ${tenantId}::uuid,
      ${period}::daterange,
      'email_volume',
      1,
      ${`${newDay}T00:00:00.001Z`}::timestamptz
    )`;

    let markers = await sql<{
      evaluation_day: string;
      evaluation_value: string;
      evaluated_state: string;
      pending: boolean;
    }[]>`
      SELECT
        evaluation_day::text,
        evaluation_value::text,
        evaluated_state,
        pending
      FROM public.usage_limit_state_evaluations
      WHERE tenant_id = ${tenantId}::uuid
        AND dimension = 'email_volume'
        AND billing_period = ${period}::daterange
        AND evaluation_day IN (${oldDay}::date, ${newDay}::date)
      ORDER BY evaluation_day
    `;
    expect(markers).toEqual([
      { evaluation_day: oldDay, evaluation_value: "5", evaluated_state: "ok", pending: true },
      { evaluation_day: newDay, evaluation_value: "1", evaluated_state: "ok", pending: true },
    ]);

    await sql`SELECT * FROM public.advance_tenant_usage_state(
      ${tenantId}::uuid, ${period}::daterange, 'email_volume', 5, 10, 20,
      false, NULL, ${oldDay}::date
    )`;
    expect(await eventCount("email_volume")).toBe(before + 1);
    await sql`SELECT * FROM public.advance_tenant_usage_state(
      ${tenantId}::uuid, ${period}::daterange, 'email_volume', 5, 10, 20,
      false, NULL, ${oldDay}::date
    )`;
    expect(await eventCount("email_volume")).toBe(before + 1);

    const [currentBeforeRecovery] = await sql<{
      email_sent_today: number;
      email_sent_day_ref: string;
      email_volume_limit_state: string;
    }[]>`
      SELECT email_sent_today, email_sent_day_ref::text, email_volume_limit_state
      FROM public.tenant_usage_metrics
      WHERE tenant_id = ${tenantId}::uuid AND billing_period = ${period}::daterange
    `;
    expect(currentBeforeRecovery).toEqual({
      email_sent_today: 1,
      email_sent_day_ref: newDay,
      email_volume_limit_state: "soft1",
    });

    await sql`SELECT * FROM public.advance_tenant_usage_state(
      ${tenantId}::uuid, ${period}::daterange, 'email_volume', 5, 10, 20,
      false, NULL, ${newDay}::date
    )`;
    expect(await eventCount("email_volume")).toBe(before + 1);

    markers = await sql<{
      evaluation_day: string;
      evaluation_value: string;
      evaluated_state: string;
      pending: boolean;
    }[]>`
      SELECT
        evaluation_day::text,
        evaluation_value::text,
        evaluated_state,
        pending
      FROM public.usage_limit_state_evaluations
      WHERE tenant_id = ${tenantId}::uuid
        AND dimension = 'email_volume'
        AND billing_period = ${period}::daterange
        AND evaluation_day IN (${oldDay}::date, ${newDay}::date)
      ORDER BY evaluation_day
    `;
    expect(markers).toEqual([
      { evaluation_day: oldDay, evaluation_value: "5", evaluated_state: "soft1", pending: false },
      { evaluation_day: newDay, evaluation_value: "1", evaluated_state: "soft1", pending: false },
    ]);
  });

  it("classifies exact monthly boundaries and only downgrades when requested", async () => {
    for (const [value, expected] of [[10, "soft1"], [20, "soft2"], [30, "hard"]] as const) {
      await sql`
        UPDATE public.tenant_usage_metrics
        SET chat_messages_count = ${value}
        WHERE tenant_id = ${otherTenantId}::uuid AND billing_period = ${period}::daterange
      `;
      await sql`SELECT * FROM public.advance_tenant_usage_state(
        ${otherTenantId}::uuid, ${period}::daterange, 'chat_volume', 10, 20, 30, false, NULL
      )`;
      const [row] = await sql<{ state: string }[]>`
        SELECT chat_volume_limit_state AS state
        FROM public.tenant_usage_metrics
        WHERE tenant_id = ${otherTenantId}::uuid AND billing_period = ${period}::daterange
      `;
      expect(row?.state).toBe(expected);
    }

    await sql`
      UPDATE public.tenant_usage_metrics
      SET chat_messages_count = 0
      WHERE tenant_id = ${otherTenantId}::uuid AND billing_period = ${period}::daterange
    `;
    await sql`SELECT * FROM public.advance_tenant_usage_state(
      ${otherTenantId}::uuid, ${period}::daterange, 'chat_volume', 10, 20, 30, false, NULL
    )`;
    let [row] = await sql<{ state: string }[]>`
      SELECT chat_volume_limit_state AS state
      FROM public.tenant_usage_metrics
      WHERE tenant_id = ${otherTenantId}::uuid AND billing_period = ${period}::daterange
    `;
    expect(row?.state).toBe("hard");

    await sql`SELECT * FROM public.advance_tenant_usage_state(
      ${otherTenantId}::uuid, ${period}::daterange, 'chat_volume', 10, 20, 30, true, 'subscription_change_recompute'
    )`;
    [row] = await sql<{ state: string }[]>`
      SELECT chat_volume_limit_state AS state
      FROM public.tenant_usage_metrics
      WHERE tenant_id = ${otherTenantId}::uuid AND billing_period = ${period}::daterange
    `;
    expect(row?.state).toBe("ok");
  });

  it("preserves nonzero promotions and classifies RAG boundaries under concurrency", async () => {
    await sql`
      INSERT INTO public.tenant_rag_quotas (
        tenant_id, base_cap, promoted_chunks_count, current_tenant_chunks_count
      ) VALUES (${tenantId}::uuid, 10, 7, 0)
      ON CONFLICT (tenant_id) DO UPDATE SET
        base_cap = 10,
        promoted_chunks_count = 7,
        current_tenant_chunks_count = 0,
        rag_state = 'ok'
    `;

    const adjusted = await Promise.all(Array.from({ length: K }, () => sql<{
      current_tenant_chunks_count: number;
      promoted_chunks_count: number;
    }[]>`SELECT * FROM public.adjust_tenant_rag_usage(${tenantId}::uuid, 1, 0)`));
    expect(adjusted.every((rows) => rows[0]?.promoted_chunks_count === 7)).toBe(true);
    await sql`SELECT * FROM public.advance_tenant_rag_state(${tenantId}::uuid, 13, 17, NULL)`;

    let [row] = await sql<{ current_tenant_chunks_count: number; promoted_chunks_count: number; rag_state: string }[]>`
      SELECT current_tenant_chunks_count, promoted_chunks_count, rag_state
      FROM public.tenant_rag_quotas WHERE tenant_id = ${tenantId}::uuid
    `;
    expect(row).toEqual({ current_tenant_chunks_count: K, promoted_chunks_count: 7, rag_state: "ok" });
    expect(await eventCount("rag_cap")).toBe(0);

    await Promise.all(Array.from({ length: 3 }, async () => {
      await sql`SELECT * FROM public.adjust_tenant_rag_usage(${tenantId}::uuid, 1, 0)`;
      await sql`SELECT * FROM public.advance_tenant_rag_state(${tenantId}::uuid, 13, 17, NULL)`;
    }));

    [row] = await sql<{ current_tenant_chunks_count: number; promoted_chunks_count: number; rag_state: string }[]>`
      SELECT current_tenant_chunks_count, promoted_chunks_count, rag_state
      FROM public.tenant_rag_quotas WHERE tenant_id = ${tenantId}::uuid
    `;
    expect(row).toEqual({ current_tenant_chunks_count: 13, promoted_chunks_count: 7, rag_state: "approaching" });
    expect(await eventCount("rag_cap")).toBe(1);
    expect(await evaluationCount("rag_cap")).toBe(0);

    await sql`UPDATE public.tenant_rag_quotas SET current_tenant_chunks_count = 17 WHERE tenant_id = ${tenantId}::uuid`;
    await sql`SELECT * FROM public.advance_tenant_rag_state(${tenantId}::uuid, 13, 17, NULL)`;
    await sql`UPDATE public.tenant_rag_quotas SET current_tenant_chunks_count = 18 WHERE tenant_id = ${tenantId}::uuid`;
    await sql`SELECT * FROM public.advance_tenant_rag_state(${tenantId}::uuid, 13, 17, NULL)`;
    const states = await sql<{ to_state: string }[]>`
      SELECT to_state FROM public.usage_limit_events
      WHERE tenant_id = ${tenantId}::uuid AND dimension = 'rag_cap'
      ORDER BY triggered_at, id
    `;
    expect(states.map((event) => event.to_state)).toEqual(["approaching", "at_cap", "over_cap"]);
    const [audit] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.tenant_rag_cap_events
      WHERE tenant_id = ${tenantId}::uuid AND event_type = 'state_transition'
    `;
    expect(audit?.n).toBe(3);
  });

  it("increments help concurrently and records one threshold transition", async () => {
    await sql`
      UPDATE public.tenant_usage_metrics
      SET help_submission_count = 19, help_submission_limit_state = 'ok'
      WHERE tenant_id = ${tenantId}::uuid AND billing_period = ${period}::daterange
    `;

    await Promise.all(Array.from({ length: K }, () => sql`
      SELECT * FROM public.increment_help_submission_usage(
        ${tenantId}::uuid, ${period}::daterange, 20, 100, 200
      )
    `));

    const [row] = await sql<{ help_submission_count: number; help_submission_limit_state: string }[]>`
      SELECT help_submission_count, help_submission_limit_state
      FROM public.tenant_usage_metrics
      WHERE tenant_id = ${tenantId}::uuid AND billing_period = ${period}::daterange
    `;
    expect(row).toEqual({ help_submission_count: 19 + K, help_submission_limit_state: "soft1" });
    expect(await eventCount("help_submission")).toBe(1);
  });
});
