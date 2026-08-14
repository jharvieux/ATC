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

// Rows carry the timestamp and relationship shapes each purge predicate uses.
type Batch = Array<{
  id: string;
  started_at?: string;
  closed_at?: string | null;
  decided_at?: string | null;
  bug_submissions?: Array<{ id: string }>;
  feature_requests?: Array<{ id: string }>;
}>;
let selectQueues: Record<string, Batch[]>;
let selectErrors: Record<string, { message: string } | undefined>;
let mutateErrors: Record<string, { message: string } | undefined>;
// Records the (column, cutoff) passed to every .lt() so tests can assert each
// purge target filters on the RIGHT timestamp column — an arg-ignoring no-op
// here would let a wrong-column purge (e.g. a non-existent one) pass silently.
let ltCalls: Array<{ table: string; column: string; cutoff: string }>;
const calls = {
  deletes: [] as Array<{ table: string; col: string; ids: string[] }>,
  updates: [] as Array<{ table: string; ids: string[] }>,
  inserts: [] as Array<{ table: string }>,
  is: [] as Array<{ table: string; column: string; value: unknown }>,
};

function makeChain(table: string) {
  return {
    select() {
      let ltCol: string | null = null;
      let ltCutoff: string | null = null;
      const nullRelations = new Set<string>();
      const chain = {
        lt(column: string, cutoff: string) {
          ltCalls.push({ table, column, cutoff });
          ltCol = column;
          ltCutoff = cutoff;
          return chain;
        },
        not() {
          return chain;
        },
        is(column: string, value: unknown) {
          calls.is.push({ table, column, value });
          if (value === null) nullRelations.add(column);
          return chain;
        },
        limit() {
          if (selectErrors[table]) return Promise.resolve({ data: null, error: selectErrors[table] });
          const batch = (selectQueues[table] ?? []).shift() ?? [];
          // Model `.lt(col, cutoff)` three-valued logic: a NULL never matches, so
          // open rows (NULL lifecycle ts) survive. A row that doesn't model the
          // column at all keeps the legacy always-eligible behavior.
          const filtered = batch.filter((row) => {
            if (ltCol) {
              const v = (row as Record<string, unknown>)[ltCol!];
              if (v === null) return false;
              if (v !== undefined && Date.parse(v as string) >= Date.parse(ltCutoff!)) return false;
            }
            return [...nullRelations].every((relation) => {
              const value = (row as Record<string, unknown>)[relation];
              return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
            });
          });
          return Promise.resolve({ data: filtered, error: null });
        },
      };
      return chain;
    },
    delete() {
      return {
        in(col: string, ids: string[]) {
          calls.deletes.push({ table, col, ids });
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

// Models Inngest step memoization: a completed step is cached by id and
// replayed on retry without re-running; a step whose fn throws is NOT cached,
// so it re-runs on the next invocation with the same step instance.
type StepCtx = { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> };
function makeStep(): StepCtx {
  const memo = new Map<string, unknown>();
  return {
    run: async (id, fn) => {
      if (memo.has(id)) return memo.get(id);
      const result = await fn();
      memo.set(id, result);
      return result;
    },
  };
}

async function runPurge(
  step: StepCtx = makeStep(),
): Promise<{ results?: Array<{ table: string; affected: number }>; skipped_for_staging?: boolean }> {
  vi.resetModules();
  const { dataRetentionPurge } = await import("@/inngest/data-retention-purge");
  const fn = dataRetentionPurge as unknown as {
    __handler: (ctx: { step: StepCtx }) => Promise<never>;
  };
  return fn.__handler({ step });
}

beforeEach(() => {
  selectQueues = {};
  selectErrors = {};
  mutateErrors = {};
  ltCalls = [];
  calls.deletes = [];
  calls.updates = [];
  calls.inserts = [];
  calls.is = [];
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

  // #2031 — gmail_inbound_messages keys on message_id (Gmail's id), not a
  // synthetic uuid. The purge must SELECT+DELETE on message_id or it would
  // target a non-existent `id` column and silently never prune (the same class
  // of bug the #1719 wrong-column test guards). Aliasing keeps the row-mapping
  // uniform while the DELETE targets the real PK.
  it("gmail_inbound_messages deletes on message_id (its PK), not id", async () => {
    selectQueues["gmail_inbound_messages"] = [ids(2, "g")];
    const result = await runPurge();

    const gDeletes = calls.deletes.filter((d) => d.table === "gmail_inbound_messages");
    expect(gDeletes).toHaveLength(1);
    expect(gDeletes[0]!.col).toBe("message_id");
    const gResult = result.results!.find((r) => r.table === "gmail_inbound_messages")!;
    expect(gResult.affected).toBe(2);
  });

  // #2033 — inbound_emails / bug_submissions / feature_requests are all in the
  // sweep now (the old comment claimed a lifecycle purge that didn't exist).
  // These pin that they're actually issued a bounded DELETE when they have
  // expired rows, on the right PK (id).
  it("inbound_emails, bug_submissions, feature_requests are swept with bounded id DELETEs", async () => {
    for (const t of ["inbound_emails", "bug_submissions", "feature_requests"]) {
      selectQueues[t] = [ids(3, t)];
    }
    const result = await runPurge();
    for (const t of ["inbound_emails", "bug_submissions", "feature_requests"]) {
      const dels = calls.deletes.filter((d) => d.table === t);
      expect(dels, `${t} should be swept`).toHaveLength(1);
      expect(dels[0]!.col).toBe("id");
      expect(result.results!.find((r) => r.table === t)!.affected).toBe(3);
    }
  });

  // #2033 — open submissions carry a NULL lifecycle timestamp (closed_at /
  // decided_at), which `.lt(col, cutoff)` never matches, so a live submission
  // must be preserved while a long-resolved one ages out. Without this pin, a
  // purge that selected open rows would delete un-triaged customer submissions.
  it("preserves open rows (NULL closed_at/decided_at) and purges only resolved ones", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const longResolved = new Date(Date.now() - 400 * DAY).toISOString();
    selectQueues["bug_submissions"] = [[
      { id: "bug-open", closed_at: null },
      { id: "bug-closed", closed_at: longResolved },
    ]];
    selectQueues["feature_requests"] = [[
      { id: "fr-open", decided_at: null },
      { id: "fr-closed", decided_at: longResolved },
    ]];
    const result = await runPurge();

    const bugDeletes = calls.deletes.filter((d) => d.table === "bug_submissions");
    expect(bugDeletes).toHaveLength(1);
    expect(bugDeletes[0]!.ids).toEqual(["bug-closed"]); // open row preserved
    expect(result.results!.find((r) => r.table === "bug_submissions")!.affected).toBe(1);

    const frDeletes = calls.deletes.filter((d) => d.table === "feature_requests");
    expect(frDeletes).toHaveLength(1);
    expect(frDeletes[0]!.ids).toEqual(["fr-closed"]); // open row preserved
    expect(result.results!.find((r) => r.table === "feature_requests")!.affected).toBe(1);
  });

  it("deletes only aged help_sessions with no surviving submission children", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const aged = new Date(Date.now() - 400 * DAY).toISOString();
    const recent = new Date(Date.now() - 30 * DAY).toISOString();
    selectQueues["help_sessions"] = [[
      { id: "aged-orphan", started_at: aged, bug_submissions: [], feature_requests: [] },
      { id: "aged-live-bug", started_at: aged, bug_submissions: [{ id: "bug-1" }], feature_requests: [] },
      { id: "aged-live-feature", started_at: aged, bug_submissions: [], feature_requests: [{ id: "feature-1" }] },
      { id: "recent-orphan", started_at: recent, bug_submissions: [], feature_requests: [] },
    ]];

    const result = await runPurge();

    expect(calls.is.filter((call) => call.table === "help_sessions")).toEqual([
      { table: "help_sessions", column: "bug_submissions", value: null },
      { table: "help_sessions", column: "feature_requests", value: null },
    ]);
    expect(calls.deletes.filter((d) => d.table === "help_sessions")).toEqual([
      { table: "help_sessions", col: "id", ids: ["aged-orphan"] },
    ]);
    expect(result.results!.find((r) => r.table === "help_sessions")!.affected).toBe(1);
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

  // #1719 — guard against a purge target pointing at a column the table does
  // not have (the DELETE would never match, the row would never prune, and the
  // fail-loud throw would fire every night). Asserting the exact column per
  // target makes this test FAIL if someone reintroduces a wrong column.
  it("each target filters on its expected timestamp column with a cutoff ≈ now − windowDays", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    // email_log filters on created_at (DEFAULT NOW(), always populated) — NOT
    // sent_at, which is NULL for rejected/failed sends and would leak that PII
    // past its retention window. See migration 20260602000000_email_notifications.
    const expected: Record<string, { column: string; days: number }> = {
      ai_call_log: { column: "created_at", days: 180 },
      ai_tool_calls: { column: "dispatched_at", days: 180 },
      email_log: { column: "created_at", days: 365 },
      notifications: { column: "created_at", days: 90 },
      attribution_touches: { column: "occurred_at", days: 365 },
      auth_attempts: { column: "occurred_at", days: 90 },
      stripe_webhook_events: { column: "created_at", days: 90 },
      // #2031 — inbound customer email content, 365d mirroring email_log.
      gmail_inbound_messages: { column: "received_at", days: 365 },
      inbound_emails: { column: "received_at", days: 365 },
      // #2033 — lifecycle timestamps: only terminal-state rows age out.
      bug_submissions: { column: "closed_at", days: 365 },
      feature_requests: { column: "decided_at", days: 365 },
      help_sessions: { column: "started_at", days: 365 },
    };

    const now = Date.now();
    await runPurge();

    for (const [table, exp] of Object.entries(expected)) {
      const call = ltCalls.find((c) => c.table === table);
      expect(call, `expected an lt() predicate for ${table}`).toBeDefined();
      expect(call!.column, `${table} must purge on ${exp.column}`).toBe(exp.column);
      const cutoffMs = Date.parse(call!.cutoff);
      const expectedMs = now - exp.days * DAY;
      // Tolerance covers the few ms between cutoff computation and this assertion.
      expect(Math.abs(cutoffMs - expectedMs)).toBeLessThan(60_000);
    }
  });

  // #1719 — the fail-loud throw retries the WHOLE Inngest function. Each COMPLETED
  // table purge and the audit write are memoized, so a retry replays them instead of
  // re-deleting rows and appending a second audit row.
  it("retry after fail-loud skips completed tables and does not duplicate the audit row", async () => {
    selectErrors["ai_call_log"] = { message: "connection reset" }; // one table fails, stays failed
    selectQueues["email_log"] = [ids(2, "e")]; // a healthy table does real deletes
    const step = makeStep();

    await expect(runPurge(step)).rejects.toThrow(/ai_call_log/);
    const deletesAfterRun1 = calls.deletes.length;
    expect(calls.deletes.some((d) => d.table === "email_log")).toBe(true);
    expect(mockWriteAuditLog).toHaveBeenCalledOnce();

    // Inngest retries the whole function with the same memoized step state.
    await expect(runPurge(step)).rejects.toThrow(/ai_call_log/);

    // Completed steps (email_log, audit) replay from the memo → no additional
    // DELETEs and the audit row is written exactly once across both attempts.
    // (The failed ai_call_log step is NOT memoized — see the #1722 test below — but
    // it throws before any DELETE, so it adds none.)
    expect(calls.deletes.length).toBe(deletesAfterRun1);
    expect(mockWriteAuditLog).toHaveBeenCalledOnce();
  });

  // #1722 — a table whose DB call errors now THROWS inside its step.run, so the
  // step is never memoized. That is what lets Inngest re-attempt just that table.
  // Before the fix the error was RETURNED (non-throwing), memoizing a one-off
  // transient blip for the whole run so the table was never retried until the next
  // day's cron. This models: fail once, then the blip clears and the retry recovers.
  it("#1722 — a failed table is re-attempted on retry (not memoized) and a transient error recovers", async () => {
    selectErrors["ai_call_log"] = { message: "connection reset" };
    const step = makeStep();

    // Run 1: ai_call_log errors → recorded failure → fail-loud throw. No delete.
    await expect(runPurge(step)).rejects.toThrow(/ai_call_log/);
    expect(calls.deletes.some((d) => d.table === "ai_call_log")).toBe(false);

    // The transient blip clears before the retry.
    selectErrors["ai_call_log"] = undefined;
    selectQueues["ai_call_log"] = [ids(2, "a")];

    // Run 2: ai_call_log's step was never memoized → it re-runs, now succeeds, and
    // the run no longer throws (its failure was not locked in for the whole run).
    const result = await runPurge(step);
    const aiDeletes = calls.deletes.filter((d) => d.table === "ai_call_log");
    expect(aiDeletes).toHaveLength(1);
    expect(aiDeletes[0]!.ids).toHaveLength(2);
    const aiResult = result.results!.find((r) => r.table === "ai_call_log")!;
    expect(aiResult.affected).toBe(2);
    expect(aiResult).not.toHaveProperty("error");
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
