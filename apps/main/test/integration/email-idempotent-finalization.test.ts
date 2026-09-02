// DB integration coverage for the keyed email finalization RPC. Unit tests
// can prove the caller contract, but only Postgres can prove the unique-index,
// transaction, UTC-day reset, recovery, and concurrent replay properties.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const adminToken = process.env.SUPABASE_SERVICE_ROLE_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;
const describeIf = supabaseUrl && adminToken && dbUrl ? describe : describe.skip;
const runTag = `email-finalize-${randomUUID().slice(0, 8)}`;
const providerCredentialHash = createHash("sha256").update("integration-api-key").digest("hex");

interface Fixtures {
  admin: SupabaseClient;
  sql: ReturnType<typeof postgres>;
  tenantOne: string;
  tenantTwo: string;
}

let fx: Fixtures;

function rpcPayload(key: string, suffix: string, retryOf: string | null = null) {
  return {
    p_idempotency_key: key,
    p_log: {
      to_email: `${suffix}@example.test`,
      from_email: "noreply@example.test",
      subject: `Subject ${suffix}`,
      template_id: "integration_test",
      template_variables: { suffix },
      email_category: "transactional",
      sent_at: new Date().toISOString(),
      resend_message_id: `resend-${runTag}-${suffix}`,
      retry_of: retryOf,
      user_id: null,
      contact_id: null,
      reply_to: null,
      related_booking_id: null,
      related_group_id: null,
    },
    p_retry_content: retryOf ? null : {
      to_email: `${suffix}@example.test`,
      subject: `Subject ${suffix}`,
      template_id: "integration_test",
      email_category: "transactional",
      html: `<p>${suffix}</p>`,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
      reply_to: null,
      related_booking_id: null,
      related_group_id: null,
      user_id: null,
      contact_id: null,
    },
  };
}

async function finalize(
  tenantId: string,
  key: string,
  suffix: string,
  retryOf: string | null = null,
): Promise<{ email_log_id: string; newly_recorded: boolean; email_sent_today: number }> {
  const payload = rpcPayload(key, suffix, retryOf);
  const { data: preparedData, error: prepareError } = await fx.admin.rpc("prepare_idempotent_email_send_v2", {
    p_tenant_id: tenantId,
    p_idempotency_key: key,
    p_provider_idempotency_key: `integration:${tenantId}:${key}`,
    p_provider_request_body: JSON.stringify({
      from: "noreply@example.test",
      to: `${suffix}@example.test`,
      subject: `Subject ${suffix}`,
      html: `<p>${suffix}</p>`,
    }),
    p_provider_account_type: "platform_resend",
    p_provider_credential_hash: providerCredentialHash,
    p_log: payload.p_log,
    p_retry_content: payload.p_retry_content,
  });
  if (prepareError) throw new Error(prepareError.message);
  const prepared = (preparedData as Array<{ sent_at: string | null }> | null)?.[0];
  if (!prepared) throw new Error("prepare_idempotent_email_send_v2 returned no row");

  if (!prepared.sent_at) {
    const { error: startError } = await fx.admin.rpc("start_idempotent_email_dispatch", {
      p_tenant_id: tenantId,
      p_idempotency_key: key,
    });
    if (startError) throw new Error(startError.message);
  }

  return finalizeEffects(tenantId, key, `resend-${runTag}-${suffix}`);
}

async function finalizeEffects(
  tenantId: string,
  key: string,
  resendMessageId: string,
): Promise<{ email_log_id: string; newly_recorded: boolean; email_sent_today: number }> {
  const { data, error } = await fx.admin.rpc("finalize_idempotent_email_send", {
    p_tenant_id: tenantId,
    p_idempotency_key: key,
    p_resend_message_id: resendMessageId,
  });
  if (error) throw new Error(error.message);
  const row = (data as Array<{
    email_log_id: string;
    newly_recorded: boolean;
    email_sent_today: number;
  }> | null)?.[0];
  if (!row) throw new Error("finalize_idempotent_email_send returned no row");
  return row;
}

describeIf("finalize_idempotent_email_send RPC (DB integration)", () => {
  beforeAll(async () => {
    const admin = createClient(supabaseUrl!, adminToken!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const sql = postgres(dbUrl!, { max: 8, idle_timeout: 20, onnotice: () => {} });
    const [tier] = await sql<{ id: string }[]>`
      SELECT id FROM public.tier_definitions WHERE code = 'byo_research' LIMIT 1
    `;
    if (!tier) throw new Error("tier_definitions not seeded — apply migrations first");
    const tenants = await sql<{ id: string }[]>`
      INSERT INTO public.tenants (slug, display_name, legal_name, tenant_type, status, tier_id)
      VALUES
        (${`${runTag}-one`}, 'Email Finalize One', 'Email Finalize One LLC', 'byo_host', 'active', ${tier.id}),
        (${`${runTag}-two`}, 'Email Finalize Two', 'Email Finalize Two LLC', 'byo_host', 'active', ${tier.id})
      RETURNING id
    `;
    if (!tenants[0] || !tenants[1]) throw new Error("tenant seed returned fewer than two rows");
    fx = { admin, sql, tenantOne: tenants[0].id, tenantTwo: tenants[1].id };
  }, 60000);

  afterAll(async () => {
    if (!fx) return;
    try {
      await fx.sql`DELETE FROM public.usage_limit_events WHERE tenant_id IN (${fx.tenantOne}, ${fx.tenantTwo})`;
      await fx.sql`DELETE FROM public.email_retry_content WHERE tenant_id IN (${fx.tenantOne}, ${fx.tenantTwo})`;
      await fx.sql`DELETE FROM public.email_provider_dispatch WHERE tenant_id IN (${fx.tenantOne}, ${fx.tenantTwo})`;
      await fx.sql`DELETE FROM public.email_log WHERE tenant_id IN (${fx.tenantOne}, ${fx.tenantTwo})`;
      await fx.sql`DELETE FROM public.tenant_usage_metrics WHERE tenant_id IN (${fx.tenantOne}, ${fx.tenantTwo})`;
      await fx.sql.begin(async (tx) => {
        await tx`SET LOCAL app.allow_tenant_hard_delete = 'true'`;
        await tx`DELETE FROM public.tenants WHERE id IN (${fx.tenantOne}, ${fx.tenantTwo})`;
      });
    } finally {
      await fx.sql.end();
    }
  }, 60000);

  it("commits the email counter and recovery marker together before state evaluation", async () => {
    await finalize(fx.tenantTwo, `${runTag}:counter-marker`, "counter-marker");

    const [committed] = await fx.sql<{ count: number; period: string; markers: number }[]>`
      SELECT
        metrics.email_sent_today::int AS count,
        metrics.billing_period::text AS period,
        (
          SELECT count(*)::int
          FROM public.usage_limit_state_evaluations AS evaluation
          WHERE evaluation.tenant_id = metrics.tenant_id
            AND evaluation.dimension = 'email_volume'
            AND evaluation.billing_period = metrics.billing_period
            AND evaluation.pending
        ) AS markers
      FROM public.tenant_usage_metrics AS metrics
      WHERE metrics.tenant_id = ${fx.tenantTwo}
      ORDER BY upper(metrics.billing_period) DESC
      LIMIT 1
    `;
    expect(committed).toMatchObject({ count: 1, markers: 1 });

    await fx.sql`SELECT * FROM public.advance_tenant_usage_state(
      ${fx.tenantTwo}::uuid,
      ${committed!.period}::daterange,
      'email_volume',
      1,
      10,
      20,
      false,
      NULL
    )`;
    const [recovered] = await fx.sql<{ state: string; markers: number; events: number }[]>`
      SELECT
        metrics.email_volume_limit_state AS state,
        (
          SELECT count(*)::int
          FROM public.usage_limit_state_evaluations AS evaluation
          WHERE evaluation.tenant_id = metrics.tenant_id
            AND evaluation.dimension = 'email_volume'
            AND evaluation.billing_period = metrics.billing_period
            AND evaluation.pending
        ) AS markers,
        (
          SELECT count(*)::int
          FROM public.usage_limit_events AS event
          WHERE event.tenant_id = metrics.tenant_id
            AND event.dimension = 'email_volume'
            AND event.resolution_action = 'state_transition'
        ) AS events
      FROM public.tenant_usage_metrics AS metrics
      WHERE metrics.tenant_id = ${fx.tenantTwo}
        AND metrics.billing_period = ${committed!.period}::daterange
    `;
    expect(recovered).toEqual({ state: "soft1", markers: 0, events: 1 });
  }, 60000);

  it("records, replays, resets the UTC day, heals an orphan, and omits retry content for retry_of", async () => {
    const first = await finalize(fx.tenantOne, `${runTag}:first`, "first");
    expect(first).toMatchObject({ newly_recorded: true, email_sent_today: 1 });
    const [firstStorage] = await fx.sql<{
      provider_request_body: string | null;
      provider_snapshot_expires_at: Date | null;
      legacy_provider_request_body: string | null;
      retry_expires_at: Date;
    }[]>`
      SELECT
        dispatch.provider_request_body,
        dispatch.provider_snapshot_expires_at,
        log.provider_request_body AS legacy_provider_request_body,
        retry.expires_at AS retry_expires_at
      FROM public.email_log AS log
      JOIN public.email_provider_dispatch AS dispatch ON dispatch.email_log_id = log.id
      JOIN public.email_retry_content AS retry ON retry.email_log_id = log.id
      WHERE log.id = ${first.email_log_id}
    `;
    expect(firstStorage).toMatchObject({
      provider_request_body: null,
      provider_snapshot_expires_at: null,
      legacy_provider_request_body: null,
    });
    expect(firstStorage!.retry_expires_at.getTime()).toBeGreaterThan(Date.now() + 6.9 * 24 * 60 * 60_000);
    expect(firstStorage!.retry_expires_at.getTime()).toBeLessThan(Date.now() + 7.1 * 24 * 60 * 60_000);

    const replay = await finalize(fx.tenantOne, `${runTag}:first`, "first");
    expect(replay).toMatchObject({
      email_log_id: first.email_log_id,
      newly_recorded: false,
      email_sent_today: 1,
    });

    const second = await finalize(fx.tenantOne, `${runTag}:second`, "second");
    expect(second.email_sent_today).toBe(2);

    await fx.sql`
      DELETE FROM public.usage_limit_state_evaluations
      WHERE tenant_id = ${fx.tenantOne}
        AND dimension = 'email_volume'
    `;
    await fx.sql`
      UPDATE public.tenant_usage_metrics
      SET email_sent_today = 99,
          email_sent_day_ref = ((clock_timestamp() AT TIME ZONE 'UTC')::date - 1),
          email_volume_limit_state = 'soft1'
      WHERE tenant_id = ${fx.tenantOne}
    `;
    const newUtcDay = await finalize(fx.tenantOne, `${runTag}:new-day`, "new-day");
    expect(newUtcDay.email_sent_today).toBe(1);
    const [newUtcDayState] = await fx.sql<{
      email_volume_limit_state: string;
      evaluated_state: string;
      evaluation_value: string;
    }[]>`
      SELECT
        metrics.email_volume_limit_state,
        evaluation.evaluated_state,
        evaluation.evaluation_value::text
      FROM public.tenant_usage_metrics AS metrics
      JOIN public.usage_limit_state_evaluations AS evaluation
        ON evaluation.tenant_id = metrics.tenant_id
       AND evaluation.dimension = 'email_volume'
       AND evaluation.billing_period = metrics.billing_period
       AND evaluation.evaluation_day = metrics.email_sent_day_ref
      WHERE metrics.tenant_id = ${fx.tenantOne}
    `;
    expect(newUtcDayState).toEqual({
      email_volume_limit_state: "soft1",
      evaluated_state: "soft1",
      evaluation_value: "1",
    });

    const [orphan] = await fx.sql<{ id: string }[]>`
      WITH inserted_log AS (
        INSERT INTO public.email_log (
          tenant_id, to_email, from_email, subject, template_id,
          email_category, status, sent_at, resend_message_id, idempotency_key,
          provider_first_attempt_at
        ) VALUES (
          ${fx.tenantOne}, 'orphan@example.test', 'noreply@example.test', 'Subject orphan',
          'integration_test', 'transactional', 'sent', now(),
          ${`resend-${runTag}-orphan`}, ${`${runTag}:orphan`}, now()
        )
        RETURNING id, tenant_id
      )
      INSERT INTO public.email_provider_dispatch (
        email_log_id, tenant_id, provider_idempotency_key,
        provider_request_body, provider_account_type, provider_credential_hash,
        provider_first_attempt_at, provider_attempt_state,
        provider_snapshot_expires_at, retry_content_snapshot
      )
      SELECT
        inserted_log.id, inserted_log.tenant_id,
        ${`integration:${fx.tenantOne}:${runTag}:orphan`},
        ${JSON.stringify({ from: "noreply@example.test", to: "orphan@example.test", subject: "Subject orphan", html: "<p>orphan</p>" })},
        'platform_resend', ${providerCredentialHash}, now(), 'ambiguous',
        now() + interval '23 hours',
        ${fx.sql.json(rpcPayload(`${runTag}:orphan`, "orphan").p_retry_content)}
      FROM inserted_log
      RETURNING email_log_id AS id
    `;
    if (!orphan) throw new Error("orphan seed returned no row");
    const healed = await finalizeEffects(fx.tenantOne, `${runTag}:orphan`, `resend-${runTag}-orphan`);
    expect(healed).toMatchObject({
      email_log_id: orphan.id,
      newly_recorded: true,
      email_sent_today: 2,
    });

    const retry = await finalize(fx.tenantOne, `${runTag}:retry`, "retry", first.email_log_id);
    expect(retry.email_sent_today).toBe(3);

    const [counts] = await fx.sql<{ logs: number; retries: number; total: number }[]>`
      SELECT
        (SELECT count(*)::int FROM public.email_log WHERE tenant_id = ${fx.tenantOne}) AS logs,
        (SELECT count(*)::int FROM public.email_retry_content WHERE tenant_id = ${fx.tenantOne}) AS retries,
        (SELECT email_sent_count::int FROM public.tenant_usage_metrics WHERE tenant_id = ${fx.tenantOne} ORDER BY upper(billing_period) DESC LIMIT 1) AS total
    `;
    expect(counts).toEqual({ logs: 5, retries: 4, total: 5 });
    const retryPayload = await fx.sql`
      SELECT 1 FROM public.email_retry_content WHERE email_log_id = ${retry.email_log_id}
    `;
    expect(retryPayload).toHaveLength(0);
  }, 60000);

  it("isolates queued provider PII and lets only rejected or unstarted rows be abandoned", async () => {
    const key = `${runTag}:private-outbox`;
    const payload = rpcPayload(key, "private-outbox");
    const prepared = await fx.admin.rpc("prepare_idempotent_email_send_v2", {
      p_tenant_id: fx.tenantOne,
      p_idempotency_key: key,
      p_provider_idempotency_key: `integration:${fx.tenantOne}:${key}`,
      p_provider_request_body: JSON.stringify({
        from: "noreply@example.test",
        to: "private-outbox@example.test",
        subject: "Private outbox",
        html: "<p>private</p>",
      }),
      p_provider_account_type: "platform_resend",
      p_provider_credential_hash: providerCredentialHash,
      p_log: payload.p_log,
      p_retry_content: payload.p_retry_content,
    });
    if (prepared.error) throw new Error(prepared.error.message);
    expect(prepared.data?.[0]).toMatchObject({
      provider_attempt_state: "unstarted",
      provider_request_body: expect.stringContaining("private-outbox@example.test"),
    });

    const [storage] = await fx.sql<{
      legacy_body: string | null;
      legacy_retry: unknown | null;
      provider_request_body: string;
      provider_attempt_state: string;
      expires_at: Date;
      created_at: Date;
    }[]>`
      SELECT
        log.provider_request_body AS legacy_body,
        log.retry_content_snapshot AS legacy_retry,
        dispatch.provider_request_body,
        dispatch.provider_attempt_state,
        dispatch.provider_snapshot_expires_at AS expires_at,
        dispatch.created_at
      FROM public.email_log AS log
      JOIN public.email_provider_dispatch AS dispatch
        ON dispatch.email_log_id = log.id
       AND dispatch.tenant_id = log.tenant_id
      WHERE log.tenant_id = ${fx.tenantOne}
        AND log.idempotency_key = ${key}
    `;
    expect(storage).toMatchObject({
      legacy_body: null,
      legacy_retry: null,
      provider_attempt_state: "unstarted",
    });
    expect(storage!.expires_at.getTime() - storage!.created_at.getTime()).toBeLessThanOrEqual(23 * 60 * 60_000);

    await expect(fx.sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE authenticated`;
      await tx`SELECT provider_request_body FROM public.email_provider_dispatch LIMIT 1`;
    })).rejects.toMatchObject({ code: "42501" });

    const started = await fx.admin.rpc("start_idempotent_email_dispatch", {
      p_tenant_id: fx.tenantOne,
      p_idempotency_key: key,
    });
    if (started.error) throw new Error(started.error.message);
    const rejected = await fx.admin.rpc("mark_idempotent_email_dispatch_rejected", {
      p_tenant_id: fx.tenantOne,
      p_idempotency_key: key,
    });
    if (rejected.error) throw new Error(rejected.error.message);
    expect(rejected.data).toBe(true);
    const recovery = await fx.admin.rpc("recover_idempotent_email_send", {
      p_tenant_id: fx.tenantOne,
      p_idempotency_key: key,
    });
    if (recovery.error) throw new Error(recovery.error.message);
    expect(recovery.data?.[0]).toMatchObject({ provider_attempt_state: "rejected" });

    const abandoned = await fx.admin.rpc("abandon_unstarted_idempotent_email", {
      p_tenant_id: fx.tenantOne,
      p_idempotency_key: key,
    });
    if (abandoned.error) throw new Error(abandoned.error.message);
    expect(abandoned.data).toBe(true);
    const remaining = await fx.sql`
      SELECT 1
      FROM public.email_log
      WHERE tenant_id = ${fx.tenantOne} AND idempotency_key = ${key}
    `;
    expect(remaining).toHaveLength(0);
  }, 60000);

  it("serializes concurrent recovery so one log, retry row, and counter are recorded", async () => {
    const before = await fx.sql<{ count: number }[]>`
      SELECT email_sent_count::int AS count
      FROM public.tenant_usage_metrics
      WHERE tenant_id = ${fx.tenantOne}
      ORDER BY upper(billing_period) DESC
      LIMIT 1
    `;
    const key = `${runTag}:concurrent`;
    const payload = rpcPayload(key, "concurrent");
    const { error: prepareError } = await fx.admin.rpc("prepare_idempotent_email_send_v2", {
      p_tenant_id: fx.tenantOne,
      p_idempotency_key: key,
      p_provider_idempotency_key: `integration:${fx.tenantOne}:${key}`,
      p_provider_request_body: JSON.stringify({ from: "noreply@example.test", to: "concurrent@example.test", subject: "Subject concurrent", html: "<p>concurrent</p>" }),
      p_provider_account_type: "platform_resend",
      p_provider_credential_hash: providerCredentialHash,
      p_log: payload.p_log,
      p_retry_content: payload.p_retry_content,
    });
    if (prepareError) throw new Error(prepareError.message);
    const { error: startError } = await fx.admin.rpc("start_idempotent_email_dispatch", {
      p_tenant_id: fx.tenantOne,
      p_idempotency_key: key,
    });
    if (startError) throw new Error(startError.message);
    const results = await Promise.all(Array.from(
      { length: 8 },
      () => finalizeEffects(fx.tenantOne, key, `resend-${runTag}-concurrent`),
    ));
    expect(results.filter((row) => row.newly_recorded)).toHaveLength(1);
    expect(new Set(results.map((row) => row.email_log_id)).size).toBe(1);

    const [after] = await fx.sql<{ logs: number; retries: number; count: number }[]>`
      SELECT
        (SELECT count(*)::int FROM public.email_log WHERE tenant_id = ${fx.tenantOne} AND idempotency_key = ${`${runTag}:concurrent`}) AS logs,
        (SELECT count(*)::int FROM public.email_retry_content erc JOIN public.email_log el ON el.id = erc.email_log_id WHERE el.tenant_id = ${fx.tenantOne} AND el.idempotency_key = ${`${runTag}:concurrent`}) AS retries,
        (SELECT email_sent_count::int FROM public.tenant_usage_metrics WHERE tenant_id = ${fx.tenantOne} ORDER BY upper(billing_period) DESC LIMIT 1) AS count
    `;
    expect(after).toEqual({ logs: 1, retries: 1, count: (before[0]?.count ?? 0) + 1 });
  }, 60000);

  it("abandons only an unstarted outbox and preserves a started attempt", async () => {
    const unstartedKey = `${runTag}:abandon-unstarted`;
    const unstartedPayload = rpcPayload(unstartedKey, "abandon-unstarted");
    const { error: unstartedPrepareError } = await fx.admin.rpc(
      "prepare_idempotent_email_send_v2",
      {
        p_tenant_id: fx.tenantOne,
        p_idempotency_key: unstartedKey,
        p_provider_idempotency_key: `integration:${fx.tenantOne}:${unstartedKey}`,
        p_provider_request_body: JSON.stringify({
          from: "noreply@example.test",
          to: "abandon-unstarted@example.test",
          subject: "Subject abandon-unstarted",
          html: "<p>abandon-unstarted</p>",
        }),
        p_provider_account_type: "platform_resend",
        p_provider_credential_hash: providerCredentialHash,
        p_log: unstartedPayload.p_log,
        p_retry_content: unstartedPayload.p_retry_content,
      },
    );
    if (unstartedPrepareError) throw new Error(unstartedPrepareError.message);

    const abandoned = await fx.admin.rpc("abandon_unstarted_idempotent_email", {
      p_tenant_id: fx.tenantOne,
      p_idempotency_key: unstartedKey,
    });
    if (abandoned.error) throw new Error(abandoned.error.message);
    expect(abandoned.data).toBe(true);
    const abandonedRows = await fx.sql`
      SELECT 1
      FROM public.email_log
      WHERE tenant_id = ${fx.tenantOne}
        AND idempotency_key = ${unstartedKey}
    `;
    expect(abandonedRows).toHaveLength(0);

    const startedKey = `${runTag}:abandon-started`;
    const startedPayload = rpcPayload(startedKey, "abandon-started");
    const { error: startedPrepareError } = await fx.admin.rpc(
      "prepare_idempotent_email_send_v2",
      {
        p_tenant_id: fx.tenantOne,
        p_idempotency_key: startedKey,
        p_provider_idempotency_key: `integration:${fx.tenantOne}:${startedKey}`,
        p_provider_request_body: JSON.stringify({
          from: "noreply@example.test",
          to: "abandon-started@example.test",
          subject: "Subject abandon-started",
          html: "<p>abandon-started</p>",
        }),
        p_provider_account_type: "platform_resend",
        p_provider_credential_hash: providerCredentialHash,
        p_log: startedPayload.p_log,
        p_retry_content: startedPayload.p_retry_content,
      },
    );
    if (startedPrepareError) throw new Error(startedPrepareError.message);
    const { error: startError } = await fx.admin.rpc("start_idempotent_email_dispatch", {
      p_tenant_id: fx.tenantOne,
      p_idempotency_key: startedKey,
    });
    if (startError) throw new Error(startError.message);

    const startedAbandon = await fx.admin.rpc("abandon_unstarted_idempotent_email", {
      p_tenant_id: fx.tenantOne,
      p_idempotency_key: startedKey,
    });
    if (startedAbandon.error) throw new Error(startedAbandon.error.message);
    expect(startedAbandon.data).toBe(false);
    const startedRows = await fx.sql<{
      status: string;
      provider_first_attempt_at: Date | null;
      provider_attempt_state: string;
    }[]>`
      SELECT log.status, dispatch.provider_first_attempt_at, dispatch.provider_attempt_state
      FROM public.email_log AS log
      JOIN public.email_provider_dispatch AS dispatch
        ON dispatch.email_log_id = log.id
       AND dispatch.tenant_id = log.tenant_id
      WHERE log.tenant_id = ${fx.tenantOne}
        AND log.idempotency_key = ${startedKey}
    `;
    expect(startedRows).toHaveLength(1);
    expect(startedRows[0]).toMatchObject({ status: "queued" });
    expect(startedRows[0]?.provider_first_attempt_at).not.toBeNull();
    expect(startedRows[0]?.provider_attempt_state).toBe("ambiguous");
  }, 60000);

  it("enforces tenant-scoped uniqueness while allowing another tenant and null keys", async () => {
    const sharedKey = `${runTag}:raw-unique`;
    await fx.sql`
      INSERT INTO public.email_log (
        tenant_id, to_email, from_email, subject, template_id, email_category, status, idempotency_key
      ) VALUES (
        ${fx.tenantOne}, 'one@example.test', 'noreply@example.test', 'One', 'integration_test', 'transactional', 'queued', ${sharedKey}
      )
    `;
    await expect(fx.sql`
      INSERT INTO public.email_log (
        tenant_id, to_email, from_email, subject, template_id, email_category, status, idempotency_key
      ) VALUES (
        ${fx.tenantOne}, 'duplicate@example.test', 'noreply@example.test', 'Duplicate', 'integration_test', 'transactional', 'queued', ${sharedKey}
      )
    `).rejects.toMatchObject({ code: "23505" });
    await fx.sql`
      INSERT INTO public.email_log (
        tenant_id, to_email, from_email, subject, template_id, email_category, status, idempotency_key
      ) VALUES
        (${fx.tenantTwo}, 'two@example.test', 'noreply@example.test', 'Two', 'integration_test', 'transactional', 'queued', ${sharedKey}),
        (${fx.tenantOne}, 'null-one@example.test', 'noreply@example.test', 'Null one', 'integration_test', 'transactional', 'queued', NULL),
        (${fx.tenantOne}, 'null-two@example.test', 'noreply@example.test', 'Null two', 'integration_test', 'transactional', 'queued', NULL)
    `;

    const retryOf = (
      await fx.sql<{ id: string }[]>`
        SELECT id FROM public.email_log
        WHERE tenant_id = ${fx.tenantOne} AND idempotency_key = ${`${runTag}:first`}
        LIMIT 1
      `
    )[0]!.id;
    const wrongTenantPayload = rpcPayload(
      `${runTag}:wrong-tenant-retry`,
      "wrong-tenant-retry",
      retryOf,
    );
    const wrongTenant = await fx.admin.rpc("prepare_idempotent_email_send_v2", {
      p_tenant_id: fx.tenantTwo,
      p_idempotency_key: `${runTag}:wrong-tenant-retry`,
      p_provider_idempotency_key: `integration:${fx.tenantTwo}:${runTag}:wrong-tenant-retry`,
      p_provider_request_body: JSON.stringify({
        from: "noreply@example.test",
        to: "wrong-tenant-retry@example.test",
        subject: "Subject wrong-tenant-retry",
        html: "<p>wrong-tenant-retry</p>",
      }),
      p_provider_account_type: "platform_resend",
      p_provider_credential_hash: providerCredentialHash,
      p_log: wrongTenantPayload.p_log,
      p_retry_content: wrongTenantPayload.p_retry_content,
    });
    expect(wrongTenant.error?.message).toMatch(/retry_of does not belong to tenant/);
  }, 60000);
});
