// #1607 — writeAuditLog is the canonical helper every audit_log INSERT
// should go through. Two of its 49+ call sites (the tenant-suspension crons,
// onboarding-stale-suspend and sub-host-review-sla-monitor) need the write
// to fail loud so Inngest retries on a dropped audit row; every other call
// site relies on writeAuditLog swallowing insert failures so a forensic
// write never masks the caller's own result. This test pins both contracts
// on the shared helper so a future change to one can't silently break the
// other.

import { beforeEach, describe, expect, it, vi } from "vitest";

let insertError: { message: string } | null = null;
let insertShouldThrow = false;
const insertSpy = vi.fn();

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        insertSpy(table, row);
        if (insertShouldThrow) throw new Error("network error");
        return Promise.resolve({ data: null, error: insertError });
      },
    }),
  }),
}));

import { writeAuditLog } from "@/lib/audit/write";

beforeEach(() => {
  insertError = null;
  insertShouldThrow = false;
  insertSpy.mockClear();
});

describe("writeAuditLog", () => {
  it("never throws by default when the insert returns an error — forensic writes must not mask the caller's result", async () => {
    insertError = { message: "connection refused" };
    await expect(
      writeAuditLog({ actor_type: "system", action: "test.event", resource_type: "test" }),
    ).resolves.toBeUndefined();
  });

  it("never throws by default when the insert itself throws", async () => {
    insertShouldThrow = true;
    await expect(
      writeAuditLog({ actor_type: "system", action: "test.event", resource_type: "test" }),
    ).resolves.toBeUndefined();
  });

  it("throws when opts.throwOnError is true and the insert returns an error — the tenant-suspension crons rely on this for Inngest retry", async () => {
    insertError = { message: "connection refused" };
    await expect(
      writeAuditLog(
        { actor_type: "system", action: "tenant.auto_suspended_stale_onboarding", resource_type: "tenant" },
        { throwOnError: true },
      ),
    ).rejects.toThrow(/connection refused/);
  });

  it("throws when opts.throwOnError is true and the insert itself throws", async () => {
    insertShouldThrow = true;
    await expect(
      writeAuditLog(
        { actor_type: "system", action: "tenant.auto_declined_review_sla", resource_type: "tenant" },
        { throwOnError: true },
      ),
    ).rejects.toThrow(/network error/);
  });

  it("does not throw with throwOnError:true when the insert succeeds", async () => {
    await expect(
      writeAuditLog(
        { actor_type: "system", action: "test.event", resource_type: "test" },
        { throwOnError: true },
      ),
    ).resolves.toBeUndefined();
  });
});
