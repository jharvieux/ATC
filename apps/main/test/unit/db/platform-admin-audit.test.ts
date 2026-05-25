// Spec ref: §5.4.8 / §26.5
//
// Verifies the audit row INSERT fires on both success and error paths,
// that nesting reuses the outer context, and that the
// manual_emergency_intervention reason requires a reason_detail string.
//
// After BP26, writeAuditLog inserts into audit_log via a dedicated
// service-role client. We mock the createServiceRoleClient factory and
// capture the insert payloads.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capturedInserts: Array<{ table: string; row: Record<string, unknown> }> = [];

vi.mock("../../../src/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        capturedInserts.push({ table, row });
        return Promise.resolve({ data: null, error: null });
      },
    }),
  }),
}));

import { withPlatformAdminAudit } from "../../../src/lib/db/platform-admin-client";

beforeEach(() => {
  capturedInserts.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

function lastAuditRow(): Record<string, unknown> | null {
  const last = capturedInserts.filter((c) => c.table === "audit_log").at(-1);
  return last?.row ?? null;
}

describe("withPlatformAdminAudit", () => {
  it("emits an audit row on the success path", async () => {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: "00000000-0000-4000-8000-00000000a001",
        reason: "tenant_listing_for_admin_dashboard",
        operation: "platformAdminListTenants",
      },
      async (_db, recordQuery) => {
        recordQuery({ op: "select", table: "tenants" });
        return 42;
      },
    );

    expect(result).toBe(42);
    const row = lastAuditRow();
    expect(row).not.toBeNull();
    expect(row!.actor_user_id).toBe("00000000-0000-4000-8000-00000000a001");
    expect(row!.action).toBe("platformAdmin.tenant_listing_for_admin_dashboard");
    expect((row!.changes as Record<string, unknown>).outcome).toBe("success");
    expect((row!.changes as Record<string, unknown>).queries).toEqual([
      { op: "select", table: "tenants" },
    ]);
  });

  it("emits an audit row on the error path AND rethrows", async () => {
    await expect(
      withPlatformAdminAudit(
        {
          admin_user_id: "00000000-0000-4000-8000-00000000a002",
          reason: "tenant_status_change",
          operation: "platformAdminSuspendTenant",
        },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    const row = lastAuditRow();
    expect(row).not.toBeNull();
    expect((row!.changes as Record<string, unknown>).outcome).toBe("error_thrown");
    expect((row!.changes as Record<string, unknown>).error_message).toBe("boom");
  });

  it("nested calls reuse the outer context (only ONE audit row emitted)", async () => {
    let outerDb: unknown;
    let innerDb: unknown;

    await withPlatformAdminAudit(
      {
        admin_user_id: "00000000-0000-4000-8000-00000000a003",
        reason: "tenant_detail_lookup",
        operation: "platformAdminGetTenant",
      },
      async (db, _record) => {
        outerDb = db;
        await withPlatformAdminAudit(
          {
            admin_user_id: "00000000-0000-4000-8000-00000000a003",
            reason: "tenant_detail_lookup",
            operation: "platformAdminGetTenantInner",
          },
          async (innerDbArg) => {
            innerDb = innerDbArg;
          },
        );
      },
    );

    // Only ONE audit_log insert from the outer call; the nested call reuses context.
    const auditInserts = capturedInserts.filter((c) => c.table === "audit_log");
    expect(auditInserts.length).toBe(1);
    expect(outerDb).toBe(innerDb);
  });

  it("non-UUID admin_user_id coerces to actor_type=system + preserves label", async () => {
    // BP30 live-dispatch surfaced that crons pass sentinel strings like
    // "system-cron" instead of a real admin UUID. Pre-fix, the audit_log
    // INSERT silently failed (UUID column rejects strings). The coercion
    // path turns these into actor_type='system' with the sentinel
    // preserved in context.system_actor_label.
    await withPlatformAdminAudit(
      {
        admin_user_id: "system-cron",
        reason: "abuse_override_revoke",
        operation: "abuse_override_expiry_sweep",
        // 2026-05-25 — abuse_override_revoke is in REASONS_REQUIRING_DETAIL.
        reason_detail: "test_fixture",
      },
      async () => undefined,
    );

    const row = lastAuditRow();
    expect(row).not.toBeNull();
    expect(row!.actor_user_id).toBeNull();
    expect(row!.actor_type).toBe("system");
    expect((row!.context as Record<string, unknown>).system_actor_label).toBe("system-cron");
  });

  it("manual_emergency_intervention without reason_detail throws", async () => {
    await expect(
      withPlatformAdminAudit(
        {
          admin_user_id: "admin-4",
          reason: "manual_emergency_intervention",
          operation: "platformAdminEmergencyFix",
        },
        async () => "should-not-reach",
      ),
    ).rejects.toThrow(/reason_detail is required/);
  });

  it("manual_emergency_intervention WITH reason_detail proceeds", async () => {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: "admin-5",
        reason: "manual_emergency_intervention",
        operation: "platformAdminEmergencyFix",
        reason_detail: "Stripe outage 2026-05-21 — manual reconciliation",
      },
      async () => "ok",
    );

    expect(result).toBe("ok");
    const row = lastAuditRow();
    expect(row).not.toBeNull();
    expect((row!.changes as Record<string, unknown>).reason_detail).toMatch(/Stripe outage/);
  });

  // 2026-05-25 — audit Auth #6 expanded the set. Spot-check a few more.
  it.each([
    "tenant_termination_processing",
    "rag_chunk_demotion",
    "abuse_override_revoke",
    "ai_kill_switch_global_pause",
  ] as const)("%s without reason_detail throws", async (reason) => {
    await expect(
      withPlatformAdminAudit(
        { admin_user_id: "admin-x", reason, operation: "test" },
        async () => "should-not-reach",
      ),
    ).rejects.toThrow(/reason_detail is required/);
  });

  it("non-destructive reasons (e.g. tenant_detail_lookup) do not require reason_detail", async () => {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: "admin-y",
        reason: "tenant_detail_lookup",
        operation: "lookup_test",
      },
      async () => "ok",
    );
    expect(result).toBe("ok");
  });
});
