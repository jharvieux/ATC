import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationsDirectory = "apps/main/supabase/migrations";
const migrations = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith(".sql"))
  .sort()
  .map((file) => ({
    file,
    sql: readFileSync(`${migrationsDirectory}/${file}`, "utf8"),
  }));
const originalMigration = migrations.find(
  ({ file }) => file === "20260831210837_precruise_send_claim.sql",
)?.sql;
const isolationMigration = migrations.find(
  ({ file }) => file === "20260901063425_isolate_email_provider_dispatch.sql",
)?.sql;

if (!originalMigration || !isolationMigration) throw new Error("email outbox migrations not found");

function effectiveFunctionBody(name: string): string {
  let effectiveBody: string | undefined;
  const definition = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    "g",
  );

  for (const migration of migrations) {
    for (const match of migration.sql.matchAll(definition)) {
      effectiveBody = match[0];
    }
  }

  if (!effectiveBody) throw new Error(`${name} migration body not found`);
  return effectiveBody;
}

describe("idempotent email outbox migration", () => {
  it("keeps provider request PII and the authoritative attempt state in a service-only table", () => {
    const precruiseAlter = originalMigration.match(
      /ALTER TABLE public\.pre_cruise_email_content[\s\S]*?;/,
    )?.[0];
    expect(precruiseAlter).toBeDefined();
    expect(precruiseAlter).not.toContain("provider_first_attempt_at");
    expect(isolationMigration).toContain("CREATE TABLE public.email_provider_dispatch");
    expect(isolationMigration).toContain("provider_attempt_state TEXT NOT NULL DEFAULT 'unstarted'");
    expect(isolationMigration).toContain("provider_request_body TEXT");
    expect(isolationMigration).toContain("retry_content_snapshot JSONB");
    expect(isolationMigration).toContain("email_log_provider_private_fields_null_chk");
    expect(isolationMigration).toContain("REVOKE ALL ON TABLE public.email_provider_dispatch FROM PUBLIC, anon, authenticated");
    expect(isolationMigration).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_provider_dispatch TO service_role");
    expect(isolationMigration).not.toMatch(/GRANT[^;]+email_provider_dispatch[^;]+authenticated/);
  });

  it("caps queued provider PII at the replay window and indexes the bounded purge", () => {
    expect(isolationMigration).toContain("v_now + INTERVAL '23 hours'");
    expect(isolationMigration).toContain("email_provider_dispatch_expiry_idx");
    expect(isolationMigration).toContain("WHERE provider_request_body IS NOT NULL");
    expect(effectiveFunctionBody("start_idempotent_email_dispatch")).toContain(
      "INTERVAL '23 hours'",
    );
  });

  it("derives finalization timestamps and UTC accounting from one captured clock value", () => {
    const body = effectiveFunctionBody("finalize_idempotent_email_send");
    expect(body.match(/clock_timestamp\(\)/g)).toHaveLength(1);
    expect(body).toContain("v_today DATE := (v_now AT TIME ZONE 'UTC')::DATE");
    expect(body).toContain("date_trunc('month', v_now AT TIME ZONE 'UTC')");
    expect(body).not.toMatch(/date_trunc\('month', clock_timestamp\(\)/);
  });

  it("keeps queued provider snapshots distinct from completed local effects", () => {
    expect(effectiveFunctionBody("prepare_idempotent_email_send")).toContain("'queued'");
    const prepareV2 = effectiveFunctionBody("prepare_idempotent_email_send_v2");
    expect(prepareV2).toContain("INTO v_prepared");
    expect(prepareV2).toContain("INTO v_provider_attempt_state");
    expect(prepareV2.indexOf("INTO v_provider_attempt_state")).toBeGreaterThan(
      prepareV2.indexOf("INTO v_prepared"),
    );
    expect(prepareV2).toContain("dispatch.provider_attempt_state");
    expect(effectiveFunctionBody("recover_idempotent_email_send")).toContain(
      "dispatch.provider_attempt_state",
    );
    expect(effectiveFunctionBody("finalize_idempotent_email_send")).toContain(
      "idempotent_effects_recorded_at = v_now",
    );
    expect(originalMigration).toContain("email_log_tenant_idempotency_key_uidx");
  });

  it("qualifies dispatch-start columns that collide with table return variables", () => {
    const body = effectiveFunctionBody("start_idempotent_email_dispatch");
    expect(body).toContain("dispatch.provider_first_attempt_at");
    expect(body).toContain(
      "dispatch.provider_snapshot_expires_at",
    );
    expect(body).toContain(
      "provider_attempt_state = 'ambiguous'",
    );
    expect(body).toContain("FOR UPDATE OF target, dispatch");
  });

  it("qualifies every email-log expression in the effective prepare and abandon RPCs", () => {
    const prepare = effectiveFunctionBody("prepare_idempotent_email_send");
    expect(prepare).toContain("FROM public.email_log AS retry_target");
    expect(prepare).toContain("retry_target.id = v_retry_of");
    expect(prepare).toContain("INSERT INTO public.email_log AS target");
    expect(prepare).toContain("RETURNING target.id INTO v_log_id");
    expect(prepare).toContain("INSERT INTO public.email_provider_dispatch");
    expect(prepare).toContain("FROM public.email_log AS target");
    expect(prepare).toContain("WHERE target.tenant_id = p_tenant_id");
    expect(prepare).not.toMatch(/RETURNING id INTO v_log_id/);

    const abandon = effectiveFunctionBody("abandon_unstarted_idempotent_email");
    expect(abandon).toContain("DELETE FROM public.email_log AS target");
    expect(abandon).toContain("USING public.email_provider_dispatch AS dispatch");
    expect(abandon).toContain("AND target.tenant_id = p_tenant_id");
    expect(abandon).toContain("AND target.idempotency_key = p_idempotency_key");
    expect(abandon).toContain("AND target.status = 'queued'");
    expect(abandon).toContain("AND target.sent_at IS NULL");
    expect(abandon).toContain("dispatch.provider_attempt_state IN ('unstarted', 'rejected')");
    expect(abandon).toContain("RETURNING target.id INTO v_deleted");
  });

  it("uses qualified expressions and an unambiguous retry constraint in the effective finalizer", () => {
    const body = effectiveFunctionBody("finalize_idempotent_email_send");
    expect(body).toContain("FROM public.email_log AS target");
    expect(body).toContain("JOIN public.email_provider_dispatch AS dispatch");
    expect(body).toContain("target.idempotent_effects_recorded_at");
    expect(body).toContain("UPDATE public.email_log AS target");
    expect(body).toContain("WHEN target.status IN ('queued', 'rejected')");
    expect(body).toContain("sent_at = COALESCE(target.sent_at, v_now)");
    expect(body).toContain(
      "resend_message_id = COALESCE(target.resend_message_id, p_resend_message_id)",
    );
    expect(body).toContain(
      "ON CONFLICT ON CONSTRAINT email_retry_content_pkey DO NOTHING",
    );
    expect(body).not.toContain("ON CONFLICT (email_log_id)");
    expect(body).toContain("INSERT INTO public.tenant_usage_metrics AS metrics");
    expect(body).toContain("email_sent_count = metrics.email_sent_count + 1");
    expect(body).toContain(
      "RETURNING metrics.email_sent_today INTO v_daily_count",
    );
    expect(body).toContain("FROM public.tenant_usage_metrics AS metrics");
    expect(body).toContain("WHERE metrics.tenant_id = p_tenant_id");
    expect(body).toContain("UPDATE public.email_provider_dispatch AS dispatch");
    expect(body).toContain("v_now + INTERVAL '7 days'");
  });

  it("persists definitive provider rejection separately from ambiguous attempts", () => {
    const markRejected = effectiveFunctionBody("mark_idempotent_email_dispatch_rejected");
    expect(markRejected).toContain("provider_attempt_state = 'rejected'");
    expect(markRejected).toContain("dispatch.provider_attempt_state = 'ambiguous'");
    expect(markRejected).toContain("target.tenant_id = p_tenant_id");
  });
});
