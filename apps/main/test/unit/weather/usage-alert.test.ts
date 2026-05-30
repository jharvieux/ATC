// §23.4 — weather-usage-alert cron contract.
//
// The cases pin WHY each behavior matters:
//   - "insufficient_history": don't alert with <3 days of data so the
//     cron doesn't false-positive in the first 72h after migration
//   - "not sustained": one day under 70% breaks the streak, no alert
//   - "sustained": all 3 days >=70% → alert + bump idempotency row
//   - "already_sent_today": same-day re-run is a no-op
//
// The cron is wrapped because it's the operator's tripwire for paying for
// Open-Meteo — false alarms desensitize, missed alarms cost money.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  lastSent: null as string | null,
  cap: 8000 as unknown,
  historyRows: [] as Array<{ metric_date: string; requests_count: number }>,
  historyError: null as { message: string } | null,
  upsertCalls: [] as Array<{ key: string; value: unknown }>,
  alertCalls: [] as Array<{ severity: string; signal: string }>,
}));

vi.mock("@/lib/monitoring/send-operator-alert", () => ({
  sendOperatorAlert: vi.fn(async (input: { severity: string; signal: string }) => {
    mocks.alertCalls.push(input);
  }),
}));

vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: vi.fn(async (p: Promise<unknown>) => p),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      if (table === "platform_settings") {
        return {
          select: () => ({
            eq: (col: string, val: string) => ({
              maybeSingle: async () => {
                if (val === "weather_usage_alert_last_sent_date") {
                  return mocks.lastSent === null
                    ? { data: null, error: null }
                    : { data: { value: mocks.lastSent }, error: null };
                }
                if (val === "weather_daily_request_cap") {
                  return { data: { value: mocks.cap }, error: null };
                }
                return { data: null, error: null };
              },
            }),
          }),
          upsert: async (row: { key: string; value: unknown }) => {
            mocks.upsertCalls.push(row);
            return { error: null };
          },
        };
      }
      if (table === "weather_usage_metrics") {
        return {
          select: () => ({
            gte: () => ({
              lte: () => ({
                order: async () => ({ data: mocks.historyRows, error: mocks.historyError }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

vi.mock("./client", () => ({
  inngest: { createFunction: (_cfg: unknown, handler: () => Promise<unknown>) => handler },
}));

vi.mock("@/inngest/client", () => ({
  inngest: { createFunction: (_cfg: unknown, handler: () => Promise<unknown>) => handler },
}));

import { weatherUsageAlert } from "@/inngest/weather-usage-alert";

const today = new Date().toISOString().slice(0, 10);

function dateNDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

beforeEach(() => {
  mocks.lastSent = null;
  mocks.cap = 8000;
  mocks.historyRows = [];
  mocks.historyError = null;
  mocks.upsertCalls = [];
  mocks.alertCalls = [];
});

describe("weather-usage-alert cron", () => {
  it("skips with insufficient_history when fewer than 3 days are present", async () => {
    mocks.historyRows = [
      { metric_date: dateNDaysAgo(1), requests_count: 7500 },
      { metric_date: dateNDaysAgo(2), requests_count: 7500 },
    ];
    const result = (await (weatherUsageAlert as unknown as () => Promise<{ skipped?: string }>)());
    expect(result.skipped).toBe("insufficient_history");
    expect(mocks.alertCalls).toHaveLength(0);
  });

  it("does not alert when one of the last 3 days is below 70% (breaks the streak)", async () => {
    mocks.historyRows = [
      { metric_date: dateNDaysAgo(3), requests_count: 5600 }, // 70%
      { metric_date: dateNDaysAgo(2), requests_count: 1000 }, // breaks streak
      { metric_date: dateNDaysAgo(1), requests_count: 5600 }, // 70%
    ];
    const result = (await (weatherUsageAlert as unknown as () => Promise<{ sustained: boolean }>)());
    expect(result.sustained).toBe(false);
    expect(mocks.alertCalls).toHaveLength(0);
    expect(mocks.upsertCalls).toHaveLength(0);
  });

  it("alerts AND bumps the idempotency row when all 3 days >= 70%", async () => {
    mocks.historyRows = [
      { metric_date: dateNDaysAgo(3), requests_count: 6000 },
      { metric_date: dateNDaysAgo(2), requests_count: 7000 },
      { metric_date: dateNDaysAgo(1), requests_count: 7500 },
    ];
    const result = (await (weatherUsageAlert as unknown as () => Promise<{ sustained: boolean; alert_sent?: boolean }>)());
    expect(result.sustained).toBe(true);
    expect(result.alert_sent).toBe(true);
    expect(mocks.alertCalls).toHaveLength(1);
    expect(mocks.alertCalls[0]?.signal).toBe("weather_usage_sustained_high");
    expect(mocks.upsertCalls[0]).toMatchObject({
      key: "weather_usage_alert_last_sent_date",
      value: today,
    });
  });

  it("is a no-op when an alert was already sent today (idempotency)", async () => {
    mocks.lastSent = today;
    mocks.historyRows = [
      { metric_date: dateNDaysAgo(3), requests_count: 9999 },
      { metric_date: dateNDaysAgo(2), requests_count: 9999 },
      { metric_date: dateNDaysAgo(1), requests_count: 9999 },
    ];
    const result = (await (weatherUsageAlert as unknown as () => Promise<{ skipped?: string }>)());
    expect(result.skipped).toBe("already_sent_today");
    expect(mocks.alertCalls).toHaveLength(0);
  });

  it("respects a re-tuned cap when computing the threshold (5000 cap → 3500 threshold)", async () => {
    mocks.cap = 5000;
    mocks.historyRows = [
      // All three days at 3500 (exactly 70% of new cap, would have been 44% of old 8000 cap)
      { metric_date: dateNDaysAgo(3), requests_count: 3500 },
      { metric_date: dateNDaysAgo(2), requests_count: 3500 },
      { metric_date: dateNDaysAgo(1), requests_count: 3500 },
    ];
    const result = (await (weatherUsageAlert as unknown as () => Promise<{ sustained: boolean }>)());
    expect(result.sustained).toBe(true);
    expect(mocks.alertCalls).toHaveLength(1);
  });
});
