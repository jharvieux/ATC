// #2139 — Postgres integration coverage for unordered Resend status events.
// Route mocks cannot prove row-lock serialization, timestamp precedence, or
// suppression atomicity, so these tests exercise the migration RPC directly.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const dbUrl = process.env.SUPABASE_DB_URL;
const describeIf = dbUrl ? describe : describe.skip;
const runTag = `resend-order-${randomUUID().slice(0, 8)}`;

interface Fixtures {
  sql: ReturnType<typeof postgres>;
  tenantId: string;
  otherTenantId: string;
}

interface ApplyResult {
  outcome: "applied" | "duplicate" | "stale" | "not_found";
  soft_retry_eligible: boolean;
}

let fx: Fixtures;

async function insertLog(
  suffix: string,
  status = "sent",
  retryOf: string | null = null,
): Promise<string> {
  const [row] = await fx.sql<{ id: string }[]>`
    INSERT INTO public.email_log (
      tenant_id,
      to_email,
      from_email,
      subject,
      template_id,
      status,
      sent_at,
      resend_message_id,
      retry_of
    ) VALUES (
      ${fx.tenantId},
      ${`${suffix}@example.test`},
      'noreply@example.test',
      ${`Subject ${suffix}`},
      'integration_test',
      ${status},
      now(),
      ${`resend-${runTag}-${suffix}`},
      ${retryOf}
    )
    RETURNING id
  `;
  if (!row) throw new Error("email_log seed returned no row");
  return row.id;
}

async function applyEvent(args: {
  logId: string;
  eventId: string;
  createdAt: string;
  status: "delivered" | "soft_bounced" | "hard_bounced" | "complained";
  tenantId?: string;
}): Promise<ApplyResult> {
  const [result] = await fx.sql<ApplyResult[]>`
    SELECT *
    FROM public.apply_resend_status_event(
      ${args.tenantId ?? fx.tenantId}::uuid,
      ${args.logId}::uuid,
      ${args.eventId},
      ${args.createdAt}::timestamptz,
      ${args.status},
      ${args.status.includes("bounced") ? args.status : null}
    )
  `;
  if (!result) throw new Error("apply_resend_status_event returned no row");
  return result;
}

async function readStatus(logId: string): Promise<{
  status: string;
  last_resend_event_id: string | null;
  last_resend_event_at: Date | null;
}> {
  const [row] = await fx.sql<{
    status: string;
    last_resend_event_id: string | null;
    last_resend_event_at: Date | null;
  }[]>`
    SELECT status, last_resend_event_id, last_resend_event_at
    FROM public.email_log
    WHERE id = ${logId}
      AND tenant_id = ${fx.tenantId}
  `;
  if (!row) throw new Error("email_log status row missing");
  return row;
}

describeIf("apply_resend_status_event RPC (DB integration)", () => {
  beforeAll(async () => {
    const sql = postgres(dbUrl!, { max: 8, idle_timeout: 20, onnotice: () => {} });
    const [tier] = await sql<{ id: string }[]>`
      SELECT id FROM public.tier_definitions WHERE code = 'byo_research' LIMIT 1
    `;
    if (!tier) throw new Error("tier_definitions not seeded — apply migrations first");
    const tenants = await sql<{ id: string }[]>`
      INSERT INTO public.tenants (slug, display_name, legal_name, tenant_type, status, tier_id)
      VALUES
        (${`${runTag}-one`}, 'Resend Order One', 'Resend Order One LLC', 'byo_host', 'active', ${tier.id}),
        (${`${runTag}-two`}, 'Resend Order Two', 'Resend Order Two LLC', 'byo_host', 'active', ${tier.id})
      RETURNING id
    `;
    if (!tenants[0] || !tenants[1]) throw new Error("tenant seed returned fewer than two rows");
    fx = { sql, tenantId: tenants[0].id, otherTenantId: tenants[1].id };
  }, 60000);

  afterAll(async () => {
    if (!fx) return;
    try {
      await fx.sql`DELETE FROM public.email_suppressions WHERE tenant_id IN (${fx.tenantId}, ${fx.otherTenantId})`;
      await fx.sql`DELETE FROM public.email_log WHERE tenant_id IN (${fx.tenantId}, ${fx.otherTenantId})`;
      await fx.sql.begin(async (tx) => {
        await tx`SET LOCAL app.allow_tenant_hard_delete = 'true'`;
        await tx`DELETE FROM public.tenants WHERE id IN (${fx.tenantId}, ${fx.otherTenantId})`;
      });
    } finally {
      await fx.sql.end();
    }
  }, 60000);

  it("keeps delivery authoritative when its stale soft bounce arrives later", async () => {
    const logId = await insertLog("delivered-stale-soft");
    const delivered = await applyEvent({
      logId,
      eventId: "msg-delivered-newer",
      createdAt: "2026-09-01T12:02:00.000Z",
      status: "delivered",
    });
    const staleSoft = await applyEvent({
      logId,
      eventId: "msg-soft-older",
      createdAt: "2026-09-01T12:01:00.000Z",
      status: "soft_bounced",
    });

    expect(delivered).toEqual({ outcome: "applied", soft_retry_eligible: false });
    expect(staleSoft).toEqual({ outcome: "stale", soft_retry_eligible: false });
    const row = await readStatus(logId);
    expect(row.status).toBe("delivered");
    expect(row.last_resend_event_id).toBe("msg-delivered-newer");
    expect(row.last_resend_event_at?.toISOString()).toBe("2026-09-01T12:02:00.000Z");
  });

  it("keeps exact soft-bounce redelivery recoverable without opening a retry chain for re-sends", async () => {
    const originalId = await insertLog("duplicate-soft");
    const event = {
      logId: originalId,
      eventId: "msg-soft-duplicate",
      createdAt: "2026-09-01T13:00:00.000Z",
      status: "soft_bounced" as const,
    };
    expect(await applyEvent(event)).toEqual({ outcome: "applied", soft_retry_eligible: true });
    expect(await applyEvent(event)).toEqual({ outcome: "duplicate", soft_retry_eligible: true });

    const retryId = await insertLog("retry-soft", "sent", originalId);
    expect(await applyEvent({ ...event, logId: retryId, eventId: "msg-retry-soft" })).toEqual({
      outcome: "applied",
      soft_retry_eligible: false,
    });
  });

  it("orders complaint and hard bounce by provider time while retaining both suppressions", async () => {
    const newerHardId = await insertLog("newer-hard");
    await applyEvent({
      logId: newerHardId,
      eventId: "msg-hard-newer",
      createdAt: "2026-09-01T14:02:00.000Z",
      status: "hard_bounced",
    });
    expect(await applyEvent({
      logId: newerHardId,
      eventId: "msg-complaint-older",
      createdAt: "2026-09-01T14:01:00.000Z",
      status: "complained",
    })).toEqual({ outcome: "stale", soft_retry_eligible: false });
    expect((await readStatus(newerHardId)).status).toBe("hard_bounced");

    const newerComplaintId = await insertLog("newer-complaint");
    await applyEvent({
      logId: newerComplaintId,
      eventId: "msg-hard-older",
      createdAt: "2026-09-01T15:01:00.000Z",
      status: "hard_bounced",
    });
    expect(await applyEvent({
      logId: newerComplaintId,
      eventId: "msg-complaint-newer",
      createdAt: "2026-09-01T15:02:00.000Z",
      status: "complained",
    })).toEqual({ outcome: "applied", soft_retry_eligible: false });
    expect((await readStatus(newerComplaintId)).status).toBe("complained");

    const [suppressionCount] = await fx.sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM public.email_suppressions
      WHERE tenant_id = ${fx.tenantId}
        AND email_address IN ('newer-hard@example.test', 'newer-complaint@example.test')
    `;
    expect(suppressionCount?.count).toBe(4);
  });

  it("uses deterministic status precedence for equal provider timestamps", async () => {
    const logId = await insertLog("equal-time");
    const at = "2026-09-01T16:00:00.000Z";
    await applyEvent({ logId, eventId: "msg-equal-delivered", createdAt: at, status: "delivered" });
    expect(await applyEvent({
      logId,
      eventId: "msg-equal-hard",
      createdAt: at,
      status: "hard_bounced",
    })).toEqual({ outcome: "applied", soft_retry_eligible: false });
    expect((await readStatus(logId)).status).toBe("hard_bounced");
    expect(await applyEvent({
      logId,
      eventId: "msg-equal-soft",
      createdAt: at,
      status: "soft_bounced",
    })).toEqual({ outcome: "stale", soft_retry_eligible: false });
  });

  it("serializes concurrent status applications and converges on the newest monotonic event", async () => {
    const deliveryLogId = await insertLog("concurrent-delivery");
    const complaintLogId = await insertLog("concurrent-complaint");

    await Promise.all([
      applyEvent({
        logId: deliveryLogId,
        eventId: "msg-concurrent-soft",
        createdAt: "2026-09-01T17:01:00.000Z",
        status: "soft_bounced",
      }),
      applyEvent({
        logId: deliveryLogId,
        eventId: "msg-concurrent-delivered",
        createdAt: "2026-09-01T17:02:00.000Z",
        status: "delivered",
      }),
      applyEvent({
        logId: complaintLogId,
        eventId: "msg-concurrent-hard",
        createdAt: "2026-09-01T18:01:00.000Z",
        status: "hard_bounced",
      }),
      applyEvent({
        logId: complaintLogId,
        eventId: "msg-concurrent-complained",
        createdAt: "2026-09-01T18:02:00.000Z",
        status: "complained",
      }),
    ]);

    expect((await readStatus(deliveryLogId)).status).toBe("delivered");
    expect((await readStatus(complaintLogId)).status).toBe("complained");
  });

  it("does not cross tenant scope and exposes the RPC only to service_role", async () => {
    const logId = await insertLog("tenant-scope");
    expect(await applyEvent({
      logId,
      eventId: "msg-wrong-tenant",
      createdAt: "2026-09-01T19:00:00.000Z",
      status: "complained",
      tenantId: fx.otherTenantId,
    })).toEqual({ outcome: "not_found", soft_retry_eligible: false });
    expect((await readStatus(logId)).status).toBe("sent");

    const [privileges] = await fx.sql<{
      service_role: boolean;
      authenticated: boolean;
      anon: boolean;
    }[]>`
      SELECT
        has_function_privilege(
          'service_role',
          'public.apply_resend_status_event(uuid,uuid,text,timestamptz,text,text)',
          'EXECUTE'
        ) AS service_role,
        has_function_privilege(
          'authenticated',
          'public.apply_resend_status_event(uuid,uuid,text,timestamptz,text,text)',
          'EXECUTE'
        ) AS authenticated,
        has_function_privilege(
          'anon',
          'public.apply_resend_status_event(uuid,uuid,text,timestamptz,text,text)',
          'EXECUTE'
        ) AS anon
    `;
    expect(privileges).toEqual({ service_role: true, authenticated: false, anon: false });
  });
});
