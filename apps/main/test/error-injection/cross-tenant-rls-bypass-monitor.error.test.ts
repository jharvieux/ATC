// D-094 / #1205 — cross-tenant-rls-bypass-monitor fail-closed probe.
//
// Before this fix the monitor destructured only `{ data }`, so a DB read
// error silently returned detected:0 instead of throwing. Covered:
//
//   - Fetch error → throws (fail-closed, not fail-open).
//   - Happy path: zero rows → detected:0, sendOperatorAlert not called.
//   - Happy path: one matching row → detected:1, sendOperatorAlert called once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; tenant_id: string | null }>,
  fetchError: null as { message: string } | null,
  alertCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(_table: string) {
      return {
        select() {
          const chain: Record<string, unknown> = {
            eq() { return chain; },
            filter() { return chain; },
            gte() { return chain; },
            limit() { return chain; },
            then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
              return resolve({ data: mocks.rows, error: mocks.fetchError });
            },
          };
          return chain;
        },
      };
    },
  }),
}));

vi.mock("@/lib/monitoring/send-operator-alert", () => ({
  sendOperatorAlert: async (payload: Record<string, unknown>) => {
    mocks.alertCalls.push(payload);
  },
}));

import { runCrossTenantRlsBypassMonitor } from "@/lib/cron/cross-tenant-rls-bypass-monitor";

beforeEach(() => {
  mocks.rows = [];
  mocks.fetchError = null;
  mocks.alertCalls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runCrossTenantRlsBypassMonitor — fail-closed (D-094 / #1205)", () => {
  it("throws when audit_log read returns an error", async () => {
    mocks.fetchError = { message: "synthetic DB error" };
    await expect(runCrossTenantRlsBypassMonitor()).rejects.toThrow(/synthetic DB error/);
  });

  it("does NOT call sendOperatorAlert when the read errors", async () => {
    mocks.fetchError = { message: "synthetic DB error" };
    await expect(runCrossTenantRlsBypassMonitor()).rejects.toThrow();
    expect(mocks.alertCalls).toHaveLength(0);
  });
});

describe("runCrossTenantRlsBypassMonitor — happy path", () => {
  it("returns detected:0 and sends no alerts when no rows match", async () => {
    const result = await runCrossTenantRlsBypassMonitor();
    expect(result).toEqual({ detected: 0 });
    expect(mocks.alertCalls).toHaveLength(0);
  });

  it("returns detected:1 and sends one critical alert when a row matches", async () => {
    mocks.rows = [{ id: "audit-1", tenant_id: "tenant-abc" }];
    const result = await runCrossTenantRlsBypassMonitor();
    expect(result).toEqual({ detected: 1 });
    expect(mocks.alertCalls).toHaveLength(1);
    expect(mocks.alertCalls[0]).toMatchObject({
      severity: "critical",
      signal: "cross_tenant_rls_bypass_attempt",
    });
  });
});
