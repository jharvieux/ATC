// §17.10 — ccpaStagingPropagationMonitor alerts the operator when the staging
// refresh (which propagates CCPA deletions from production) hasn't run in 25+
// days. Real tests for the shipped monitor, replacing stale it.todo stubs in
// test/unit/legal/consent.test.ts that described this exact behavior for code
// that had already shipped (#1794).

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceClient: vi.fn(),
  sendAlert: vi.fn(),
}));

vi.mock("@/lib/db/service-role-client", () => ({ createServiceRoleClient: mocks.serviceClient }));
vi.mock("@/lib/monitoring/send-operator-alert", () => ({ sendOperatorAlert: mocks.sendAlert }));
vi.mock("@/inngest/client", () => ({
  inngest: { createFunction: (_config: unknown, handler: unknown) => ({ handler }) },
}));

import { ccpaStagingPropagationMonitor } from "@/inngest/ccpa-staging-propagation-monitor";

const fn = ccpaStagingPropagationMonitor as unknown as { handler: () => Promise<unknown> };

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function mockDb(lastRefreshAt: string | null, deletedUserCount: number) {
  mocks.serviceClient.mockReturnValue({
    from: (table: string) => {
      if (table === "platform_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: lastRefreshAt ? { value: lastRefreshAt } : null,
                error: null,
              }),
            }),
          }),
        };
      }
      // "users" — count of pending CCPA deletions.
      return {
        select: () => ({
          not: async () => ({ count: deletedUserCount, error: null }),
        }),
      };
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ccpaStagingPropagationMonitor (#1794)", () => {
  it("fires an operator alert when the last refresh is 25+ days ago", async () => {
    mockDb(daysAgo(26), 3);
    await fn.handler();
    expect(mocks.sendAlert).toHaveBeenCalledOnce();
    const call = mocks.sendAlert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.severity).toBe("high");
    expect(call.signal).toBe("ccpa_staging_refresh_overdue");
    expect(call.payload).toMatchObject({ pending_deletion_count: 3, threshold_days: 25 });
  });

  it("does NOT alert when the last refresh is under 25 days ago", async () => {
    mockDb(daysAgo(24), 3);
    await fn.handler();
    expect(mocks.sendAlert).not.toHaveBeenCalled();
  });
});
