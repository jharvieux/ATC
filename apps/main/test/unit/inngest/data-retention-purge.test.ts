// #1590 — data-retention-purge cron.
//
// Tests verify WHY the behavior matters:
//   - Deletes are BATCHED and BOUNDED: a table with more than one batch of
//     expired rows is drained across multiple bounded DELETEs, not one
//     unbounded `DELETE WHERE ts < cutoff` that could lock the table.
//   - stripe_webhook_events is NULLed, never deleted: the dedup row must
//     survive so a replayed event stays recognisable as a duplicate; only the
//     PII-bearing raw_event payload is scrubbed.
//   - Fail-loud + resilient: one table's error does not abort the others, but
//     the run still THROWS at the end so alerting fires (a silently-degraded
//     purge is how PII quietly outlives its retention window).
//   - Windows are env-configurable with safe fallbacks.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_: unknown, handler: unknown) => ({ __handler: handler }),
  },
}));

const mockWriteAuditLog = vi.fn(async (_row: { action: string; [k: string]: unknown }) => {});
vi.mock("@/lib/audit/write", () => ({ writeAuditLog: mockWriteAuditLog }));

type Batch = Array<{ id: string }>;
let selectQueues: Record<string, Batch[]>;
let selectErrors: Record<string, { message: string } | undefined>;
let mutateErrors: Record<string, { message: string } | undefined>;
const calls = {
  deletes: [] as Array<{ table: string; ids: string[] }>,
  updates: [] as Array<{ table: string; ids: string[] }>,
  inserts: [] as Array<{ table: string }>,
};

function makeChain(table: string) {
  return {
    select() {
      const chain = {
        lt() {
          return chain;
        },
        not() {
          return chain;
        },
        limit() {
          if (selectErrors[table]) return Promise.resolve({ data: null, error: selectErrors[table] });
          const batch = (selectQueues[table] ?? []).shift() ?? [];
          return Promise.resolve({ data: batch, error: null });
        },
      };
      return chain;
    },
    delete() {
      return {
        in(_col: string, ids: string[]) {
          calls.deletes.push({ table, ids });
          if (mutateErrors[table]) return Promise.resolve({ count: null, error: mutateErrors[table] });
          return Promise.resolve({ count: ids.length, error: null });
        },
      };
    },
    update() {
      return {
        in(_col: string, ids: string[]) {
          calls.updates.push({ table, ids });
          if (mutateErrors[table]) return Promise.resolve({ error: mutateErrors[table] });
          return Promise.resolve({ error: null });
        },
      };
    },
    insert() {
      calls.inserts.push({ table });
      return Promise.resolve({ error: null });
    },
  };
}

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({ from: (t: string) => makeChain(t) }),
}));

function ids(n: number, prefix = "x"): Batch {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));
}

async function runPurge(): Promise<{ results?: Array<{ table: string; affected: number }>; skipped_for_staging?: boolean }> {
  vi.resetModules();
  const { dataRetentionPurge } = await import("@/inngest/data-retention-purge");
  const fn = dataRetentionPurge as unknown as { __handler: () => Promise<never> };
  return fn.__handler();
}

beforeEach(() => {
  selectQueues = {};
  selectErrors = {};
  mutateErrors = {};
  calls.deletes = [];
  calls.updates = [];
  calls.inserts = [];
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("STAGING_MODE", "");
});

describe("data-retention-purge — #1590", () => {
  it("STAGING_MODE skips all work and records the skip", async () => {
    vi.stubEnv("STAGING_MODE", "true");
    const result = await runPurge();
    expect(result).toEqual({ skipped_for_staging: true });
    expect(calls.inserts).toEqual([{ table: "staging_cron_skips" }]);
    expect(calls.deletes).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });

  it("empty tables issue no DELETE/UPDATE and complete cleanly", async () => {
    const result = await runPurge();
    expect(result.results).toBeDefined();
    expect(calls.deletes).toHaveLength(0);
    // stripe scrub also finds nothing → no update.
    expect(calls.updates).toHaveLength(0);
    expect(mockWriteAuditLog).toHaveBeenCalledOnce();
    const audit = mockWriteAuditLog.mock.calls[0]![0] as { action: string };
    expect(audit.action).toBe("data_retention_purge");
  });

  it("drains a multi-batch table with bounded per-batch DELETEs (not one unbounded delete)", async () => {
    // 1000 (full batch) then 3 (short batch) → two bounded deletes, then stop.
    selectQueues["ai_call_log"] = [ids(1000, "b1"), ids(3, "b2")];
    const result = await runPurge();

    const aiDeletes = calls.deletes.filter((d) => d.table === "ai_call_log");
    expect(aiDeletes).toHaveLength(2);
    expect(aiDeletes[0]!.ids).toHaveLength(1000);
    expect(aiDeletes[1]!.ids).toHaveLength(3);
    const aiResult = result.results!.find((r) => r.table === "ai_call_log")!;
    expect(aiResult.affected).toBe(1003);
  });

  it("stripe_webhook_events is scrubbed via UPDATE (raw_event NULLed), never DELETEd", async () => {
    selectQueues["stripe_webhook_events"] = [ids(2, "s")];
    const result = await runPurge();

    // Dedup rows preserved: no delete against this table…
    expect(calls.deletes.some((d) => d.table === "stripe_webhook_events")).toBe(false);
    // …only a null-out update.
    const upd = calls.updates.filter((u) => u.table === "stripe_webhook_events");
    expect(upd).toHaveLength(1);
    expect(upd[0]!.ids).toEqual(["s-0", "s-1"]);
    const stripeResult = result.results!.find((r) => r.table === "stripe_webhook_events.raw_event")!;
    expect(stripeResult.affected).toBe(2);
  });

  it("one table's error does not abort the others, but the run THROWS (fail-loud)", async () => {
    selectErrors["ai_call_log"] = { message: "connection reset" };
    selectQueues["email_log"] = [ids(1, "e")]; // a later table still gets swept

    await expect(runPurge()).rejects.toThrow(/ai_call_log/);

    // The healthy table was still processed despite the earlier failure.
    expect(calls.deletes.some((d) => d.table === "email_log")).toBe(true);
    // The failure is recorded in the audit row with the partial-failure action.
    const audit = mockWriteAuditLog.mock.calls[0]![0] as { action: string };
    expect(audit.action).toBe("data_retention_purge_partial_failure");
  });
});

describe("resolveWindowDays — #1590 env configurability", () => {
  it("uses the env override when set to a positive number", async () => {
    vi.resetModules();
    vi.stubEnv("AI_CALL_LOG_RETENTION_DAYS", "30");
    const { resolveWindowDays } = await import("@/inngest/data-retention-purge");
    expect(resolveWindowDays("AI_CALL_LOG_RETENTION_DAYS", 180)).toBe(30);
  });

  it("falls back to the default for unset, non-numeric, or non-positive values", async () => {
    vi.resetModules();
    vi.stubEnv("AI_CALL_LOG_RETENTION_DAYS", "not-a-number");
    vi.stubEnv("EMAIL_LOG_RETENTION_DAYS", "-5");
    const { resolveWindowDays } = await import("@/inngest/data-retention-purge");
    expect(resolveWindowDays("AI_CALL_LOG_RETENTION_DAYS", 180)).toBe(180);
    expect(resolveWindowDays("EMAIL_LOG_RETENTION_DAYS", 365)).toBe(365);
    expect(resolveWindowDays("NOTIFICATIONS_RETENTION_DAYS", 90)).toBe(90);
  });
});
