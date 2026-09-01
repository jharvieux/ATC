import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "apps/main/supabase/migrations/20260831210837_precruise_send_claim.sql",
  "utf8",
);
const dispatchStartCorrection = readFileSync(
  "apps/main/supabase/migrations/20260901053127_fix_email_dispatch_start_ambiguity.sql",
  "utf8",
);

function functionBody(name: string): string {
  const match = migration.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`),
  );
  if (!match) throw new Error(`${name} migration body not found`);
  return match[0];
}

describe("idempotent email outbox migration", () => {
  it("keeps the immutable provider epoch and credential binding on email_log only", () => {
    const precruiseAlter = migration.match(
      /ALTER TABLE public\.pre_cruise_email_content[\s\S]*?;/,
    )?.[0];
    expect(precruiseAlter).toBeDefined();
    expect(precruiseAlter).not.toContain("provider_first_attempt_at");
    expect(migration).toContain("ADD COLUMN provider_credential_hash TEXT");
    expect(functionBody("prepare_idempotent_email_send")).toContain(
      "p_provider_credential_hash TEXT",
    );
    expect(functionBody("start_idempotent_email_dispatch")).toContain(
      "email_log.provider_first_attempt_at",
    );
  });

  it("derives finalization timestamps and UTC accounting from one captured clock value", () => {
    const body = functionBody("finalize_idempotent_email_send");
    expect(body.match(/clock_timestamp\(\)/g)).toHaveLength(1);
    expect(body).toContain("v_today DATE := (v_now AT TIME ZONE 'UTC')::DATE");
    expect(body).toContain("date_trunc('month', v_now AT TIME ZONE 'UTC')");
    expect(body).not.toMatch(/date_trunc\('month', clock_timestamp\(\)/);
  });

  it("keeps queued provider snapshots distinct from completed local effects", () => {
    expect(functionBody("prepare_idempotent_email_send")).toContain("'queued'");
    expect(functionBody("start_idempotent_email_dispatch")).toContain("INTERVAL '23 hours'");
    expect(functionBody("finalize_idempotent_email_send")).toContain(
      "idempotent_effects_recorded_at = v_now",
    );
    expect(migration).toContain("email_log_tenant_idempotency_key_uidx");
  });

  it("qualifies dispatch-start columns that collide with table return variables", () => {
    expect(dispatchStartCorrection).toContain("target.provider_first_attempt_at");
    expect(dispatchStartCorrection).toContain(
      "target.provider_snapshot_expires_at",
    );
    expect(dispatchStartCorrection).toContain(
      "target.provider_first_attempt_at IS NULL",
    );
    expect(dispatchStartCorrection).not.toContain(
      "AND provider_first_attempt_at IS NULL",
    );
  });
});
