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
  const { data: preparedData, error: prepareError } = await fx.admin.rpc("prepare_idempotent_email_send", {
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
  if (!prepared) throw new Error("prepare_idempotent_email_send returned no row");

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
      await fx.sql`DELETE FROM public.email_retry_content WHERE tenant_id IN (${fx.tenantOne}, ${fx.tenantTwo})`;
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

  it("records, replays, resets the UTC day, heals an orphan, and omits retry content for retry_of", async () => {
    const first = await finalize(fx.tenantOne, `${runTag}:first`, "first");
    expect(first).toMatchObject({ newly_recorded: true, email_sent_today: 1 });

    const replay = await finalize(fx.tenantOne, `${runTag}:first`, "first");
    expect(replay).toMatchObject({
      email_log_id: first.email_log_id,
      newly_recorded: false,
      email_sent_today: 1,
    });

    const second = await finalize(fx.tenantOne, `${runTag}:second`, "second");
    expect(second.email_sent_today).toBe(2);

    await fx.sql`
      UPDATE public.tenant_usage_metrics
      SET email_sent_today = 99,
          email_sent_day_ref = ((clock_timestamp() AT TIME ZONE 'UTC')::date - 1)
      WHERE tenant_id = ${fx.tenantOne}
    `;
    const newUtcDay = await finalize(fx.tenantOne, `${runTag}:new-day`, "new-day");
    expect(newUtcDay.email_sent_today).toBe(1);

    const [orphan] = await fx.sql<{ id: string }[]>`
      INSERT INTO public.email_log (
        tenant_id, to_email, from_email, subject, template_id,
        email_category, status, sent_at, resend_message_id, idempotency_key,
        provider_idempotency_key, provider_request_body, provider_account_type,
        provider_credential_hash, provider_first_attempt_at,
        provider_snapshot_expires_at, retry_content_snapshot
      ) VALUES (
        ${fx.tenantOne}, 'orphan@example.test', 'noreply@example.test', 'Subject orphan',
        'integration_test', 'transactional', 'sent', now(),
        ${`resend-${runTag}-orphan`}, ${`${runTag}:orphan`},
        ${`integration:${fx.tenantOne}:${runTag}:orphan`},
        ${JSON.stringify({ from: "noreply@example.test", to: "orphan@example.test", subject: "Subject orphan", html: "<p>orphan</p>" })},
        'platform_resend', ${providerCredentialHash}, now(), now() + interval '7 days',
        ${JSON.stringify(rpcPayload(`${runTag}:orphan`, "orphan").p_retry_content)}::jsonb
      )
      RETURNING id
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
    const { error: prepareError } = await fx.admin.rpc("prepare_idempotent_email_send", {
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
    const wrongTenant = await fx.admin.rpc("prepare_idempotent_email_send", {
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
