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
        admin_user_id: "admin-1",
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
    expect(row!.actor_user_id).toBe("admin-1");
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
          admin_user_id: "admin-2",
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
        admin_user_id: "admin-3",
        reason: "tenant_detail_lookup",
        operation: "platformAdminGetTenant",
      },
      async (db, _record) => {
        outerDb = db;
        await withPlatformAdminAudit(
          {
            admin_user_id: "admin-3",
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
});
