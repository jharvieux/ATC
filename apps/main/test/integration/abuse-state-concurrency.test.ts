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

  it("serializes chat/email/group increments without crossing tenant scope", async () => {
    for (const dimension of ["chat_volume", "email_volume", "group_invite"] as const) {
      await Promise.all(Array.from({ length: K }, () => sql`
        SELECT public.increment_tenant_usage_counter(
          ${tenantId}::uuid,
          ${period}::daterange,
          ${dimension},
          1
        )
      `));
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
      chat_messages_count: K,
      email_sent_count: K,
      email_sent_today: K,
      group_invitees_count: K,
    });

    const [other] = await sql<{ total: number }[]>`
      SELECT (chat_messages_count + email_sent_count + group_invitees_count)::int AS total
      FROM public.tenant_usage_metrics
      WHERE tenant_id = ${otherTenantId}::uuid AND billing_period = ${period}::daterange
    `;
    expect(other?.total).toBe(0);
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
    expect(await eventCount("email_volume")).toBe(1);
    expect(await evaluationCount("email_volume")).toBe(0);
  });

  it("creates one RAG logical transition and one RAG audit under concurrent adjustment", async () => {
    await sql`
      INSERT INTO public.tenant_rag_quotas (tenant_id, base_cap, current_tenant_chunks_count)
      VALUES (${tenantId}::uuid, 100, 0)
      ON CONFLICT (tenant_id) DO UPDATE SET current_tenant_chunks_count = 0, rag_state = 'ok'
    `;

    await Promise.all(Array.from({ length: K }, async () => {
      await sql`SELECT public.adjust_tenant_rag_usage(${tenantId}::uuid, 1, 0)`;
      await sql`SELECT * FROM public.advance_tenant_rag_state(${tenantId}::uuid, 5, 100, NULL)`;
    }));

    const [row] = await sql<{ current_tenant_chunks_count: number; rag_state: string }[]>`
      SELECT current_tenant_chunks_count, rag_state
      FROM public.tenant_rag_quotas WHERE tenant_id = ${tenantId}::uuid
    `;
    expect(row).toEqual({ current_tenant_chunks_count: K, rag_state: "approaching" });
    expect(await eventCount("rag_cap")).toBe(1);
    expect(await evaluationCount("rag_cap")).toBe(0);
    const [audit] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.tenant_rag_cap_events
      WHERE tenant_id = ${tenantId}::uuid AND event_type = 'state_transition'
    `;
    expect(audit?.n).toBe(1);
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
