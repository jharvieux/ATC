// #900 — task-reminders-fire drain loop.
// #1581 — CAS row claim (sending_at) prevents double-send on cron overlap.
//
// Covers:
//   - Drain loop: a backlog > BATCH_LIMIT is fully drained in one run.
//   - §37.3.3 snooze suppression: remind_at < snoozed_until → status=suppressed.
//   - Email channel: sendTaskReminderEmail called, status=delivered.
//   - Per-row failure: safeAwait throws → failed++ without aborting the run,
//     and the claim is released so the next run retries.
//   - #1581: two overlapping runs over the same rows produce exactly one
//     send per row.
//   - #1581 split try/catch: a pre-dispatch failure releases the claim
//     (safe retry); a post-dispatch/finalize failure does NOT (would double-send).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/tasks/send-reminder-email", () => ({
  sendTaskReminderEmail: vi.fn(async () => ({ status: "sent" })),
}));

vi.mock("@/lib/db/safe-mutation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/safe-mutation")>("@/lib/db/safe-mutation");
  return {
    ...actual,
    // Wraps the real unwrap-and-throw behavior (not a no-op passthrough) so
    // mock DB results carrying `{data:null, error:{...}}` actually throw,
    // same as production — needed for the #1581 finalize-failure tests below.
    safeAwait: vi.fn(actual.safeAwait),
  };
});

// The DB mock models task_reminders as an in-memory table so the CAS claim
// (.update({sending_at}).eq("id",_).is("fired_at",null).or(...).select("id"))
// and the stamp/release updates all observe the same row state — this is
// what lets the concurrent-run test below prove the claim actually works.
const BATCH_LIMIT = 200;
type StoredRow = {
  id: string;
  tenant_id: string;
  task_id: string;
  channel: "in_app" | "email";
  remind_at: string;
  fired_at: string | null;
  fired_status: "delivered" | "suppressed" | "failed" | null;
  sending_at: string | null;
  tasks: { snoozed_until: string | null; assigned_to_user_id: null; status: "open"; title: string };
};
let table: StoredRow[] = [];
// #1581 regression tests: row ids in this set fail their NEXT finalize-stamp
// update (the `.update({fired_at, fired_status, sending_at:null})` call) with
// a synthetic DB error, then self-clear — lets a test inject exactly one
// post-dispatch failure to prove the claim is retained (not released).
let finalizeFailIds = new Set<string>();
// #1679: row ids here lose their NEXT claim attempt — the claim `.select("id")`
// returns [] (as it would when a concurrent run claimed the row between this
// run's batch select and its per-row claim), letting a test exercise the
// claim-race skip path deterministically in a single-threaded mock.
let claimFailIds = new Set<string>();

function makeDb() {
  return {
    from(name: string) {
      if (name !== "task_reminders") {
        return {
          select() { return this; },
          update() { return this; },
          eq() { return { then: (r: (v: { error: null }) => unknown) => Promise.resolve(r({ error: null })) }; },
        };
      }

      return {
        select() {
          const filters: Array<(r: StoredRow) => boolean> = [];
          const chain = {
            is(col: string, _v: null) {
              filters.push((r) => (r as unknown as Record<string, unknown>)[col] === null);
              return chain;
            },
            or(expr: string) {
              // Only expression this cron issues: "sending_at.is.null,sending_at.lt.<iso>"
              const parts = expr.split(",");
              const cutoff = parts[1]!.split("sending_at.lt.")[1]!;
              filters.push((r) => r.sending_at === null || r.sending_at < cutoff);
              return chain;
            },
            lte(col: string, v: string) {
              filters.push((r) => ((r as unknown as Record<string, string>)[col] ?? "") <= v);
              return chain;
            },
            limit(n: number) {
              const matched = table.filter((r) => filters.every((f) => f(r)));
              const batch = matched.slice(0, n);
              return { then: (resolve: (v: { data: StoredRow[]; error: null }) => unknown) => Promise.resolve(resolve({ data: batch, error: null })) };
            },
          };
          return chain;
        },
        // update().eq("id", id) then either .is(...).or(...).select("id") (claim)
        // or .then() directly (final stamp / release).
        update(payload: Partial<StoredRow>) {
          let targetId: string | undefined;
          const applyIfMatch = (extraGuard: (r: StoredRow) => boolean) => {
            const row = table.find((r) => r.id === targetId && extraGuard(r));
            if (row) Object.assign(row, payload);
            return row;
          };
          const chain = {
            eq(_col: string, id: string) {
              targetId = id;
              return chain;
            },
            is(col: string, _v: null) {
              const guardCol = col as keyof StoredRow;
              const prevGuards = chain._guards;
              chain._guards = [...prevGuards, (r: StoredRow) => r[guardCol] === null];
              return chain;
            },
            or(expr: string) {
              const cutoff = expr.split("sending_at.lt.")[1]!;
              const prevGuards = chain._guards;
              chain._guards = [...prevGuards, (r: StoredRow) => r.sending_at === null || r.sending_at < cutoff];
              return chain;
            },
            select(_cols: string) {
              // #1679 — simulate losing the claim race to a concurrent run.
              if (targetId !== undefined && claimFailIds.has(targetId)) {
                claimFailIds.delete(targetId);
                return Promise.resolve({ data: [], error: null });
              }
              const row = applyIfMatch((r) => chain._guards.every((g) => g(r)));
              return Promise.resolve({ data: row ? [{ id: row.id }] : [], error: null });
            },
            then(resolve: (v: { data: null; error: { message: string } | null }) => unknown) {
              // The finalize stamp (`.update({fired_at, fired_status, sending_at:null})`)
              // is the only update() call carrying `fired_at`; the release-claim call
              // (`.update({sending_at:null})`) does not. Use that to target injected
              // failures at finalize specifically, without touching the release path.
              if ("fired_at" in payload && targetId !== undefined && finalizeFailIds.has(targetId)) {
                finalizeFailIds.delete(targetId);
                return Promise.resolve(resolve({ data: null, error: { message: "synthetic finalize failure" } }));
              }
              applyIfMatch(() => true);
              return Promise.resolve(resolve({ data: null, error: null }));
            },
            _guards: [] as Array<(r: StoredRow) => boolean>,
          };
          return chain;
        },
      };
    },
  };
}

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => makeDb(),
}));

function makeRow(id: string, overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    id,
    tenant_id: "t-1",
    task_id: `task-${id}`,
    channel: "in_app",
    remind_at: new Date(Date.now() - 1000).toISOString(),
    fired_at: null,
    fired_status: null,
    sending_at: null,
    tasks: { snoozed_until: null, assigned_to_user_id: null, status: "open", title: "Test task" },
    ...overrides,
  };
}

import { runTaskRemindersFire, tryClaimReminderRow } from "@/lib/cron/task-reminders-fire";
import { sendTaskReminderEmail } from "@/lib/tasks/send-reminder-email";
import { safeAwait } from "@/lib/db/safe-mutation";

type FireResult = { processed: number; delivered: number; suppressed: number; failed: number; skipped: number; batches: number };
const run = runTaskRemindersFire as unknown as () => Promise<FireResult>;

beforeEach(() => {
  table = [];
  finalizeFailIds = new Set();
  claimFailIds = new Set();
  vi.clearAllMocks();
});

describe("task-reminders-fire — drain loop (#900)", () => {
  it("single batch: processes all rows and reports batches=1", async () => {
    for (let i = 0; i < 50; i++) table.push(makeRow(`r-${i}`));
    const result = await run();
    expect(result.processed).toBe(50);
    expect(result.batches).toBe(1);
  });

  it("#900: multi-batch: drains a pool of BATCH_LIMIT+1 rows in 2 batches", async () => {
    for (let i = 0; i < BATCH_LIMIT + 1; i++) table.push(makeRow(`r-${i}`));
    const result = await run();
    expect(result.processed).toBe(BATCH_LIMIT + 1);
    expect(result.batches).toBe(2);
    expect(table.every((r) => r.fired_at !== null)).toBe(true);
  });

  it("exactly BATCH_LIMIT rows: exits after 2 fetches (second returns empty)", async () => {
    for (let i = 0; i < BATCH_LIMIT; i++) table.push(makeRow(`r-${i}`));
    const result = await run();
    expect(result.processed).toBe(BATCH_LIMIT);
    // First batch full (200) → re-queries; second batch empty (0) → breaks.
    expect(result.batches).toBe(2);
  });

  it("empty pool: processes 0 rows in 1 batch", async () => {
    const result = await run();
    expect(result.processed).toBe(0);
    expect(result.batches).toBe(1);
  });

  it("time-budget: loop exits when TIME_BUDGET_MS is elapsed even if backlog remains", async () => {
    // Seed 2 full batches; without the budget guard both would be fetched.
    for (let i = 0; i < BATCH_LIMIT * 2; i++) table.push(makeRow(`r-${i}`));
    // Simulate elapsed time via Date.now(): start=0, first loop check (0ms),
    // second check (after first batch processes) sees 60s elapsed → exits.
    let nowCalls = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls++;
      return nowCalls <= 2 ? 0 : 60_000; // call 1=start, call 2=first check, call 3+=budget exceeded
    });
    const result = await run();
    nowSpy.mockRestore();
    expect(result.processed).toBe(BATCH_LIMIT);
    expect(result.batches).toBe(1);
    // Second batch never fetched — only the first BATCH_LIMIT rows were claimed/processed
    expect(table.filter((r) => r.fired_at !== null)).toHaveLength(BATCH_LIMIT);
  });
});

describe("task-reminders-fire — per-row behaviors", () => {
  it("§37.3.3: snooze suppression — remind_at inside snoozed_until window → suppressed=1, delivered=0", async () => {
    const remindAt = new Date(Date.now() - 1000).toISOString();
    const snoozedUntil = new Date(Date.now() + 60_000).toISOString();
    table.push(makeRow("snoozed", {
      remind_at: remindAt,
      tasks: { snoozed_until: snoozedUntil, assigned_to_user_id: null, status: "open", title: "Snoozed task" },
    }));
    const result = await run();
    expect(result.suppressed).toBe(1);
    expect(result.delivered).toBe(0);
    expect(vi.mocked(sendTaskReminderEmail)).not.toHaveBeenCalled();
  });

  it("email channel: sendTaskReminderEmail called → delivered=1", async () => {
    table.push(makeRow("email-row", { channel: "email" }));
    const result = await run();
    expect(vi.mocked(sendTaskReminderEmail)).toHaveBeenCalledTimes(1);
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("#1581 pre-dispatch failure: release the claim so the row is immediately retryable", async () => {
    // Inject a throw from inside the pre-dispatch try (lines 110-133 of the
    // source) — sendTaskReminderEmail is documented to "never throw", so an
    // unexpected throw here exercises the same catch a real bug (e.g. a
    // thrown error while resolving snooze/task state) would hit. No send has
    // happened, so the claim must be released for a safe, immediate retry.
    vi.mocked(sendTaskReminderEmail).mockRejectedValueOnce(new Error("synthetic pre-dispatch failure"));
    table.push(makeRow("pre-fail-row", { channel: "email" }));
    const result = await run();

    expect(result.failed).toBe(1);
    expect(result.delivered).toBe(0);
    const row = table.find((r) => r.id === "pre-fail-row")!;
    expect(row.sending_at).toBeNull(); // claim released — safe, no send occurred
    expect(row.fired_at).toBeNull(); // never finalized this pass
  });

  it("#1581 post-dispatch/finalize failure: claim is NOT released, preventing a duplicate send", async () => {
    // This is the regression #1581 exists to prevent: the send succeeds, but
    // the finalize `.update({fired_at, fired_status, sending_at:null})` call
    // (lines 152-157 of the source) throws. If the claim were released here,
    // the very next batch would re-claim the row and send a real duplicate
    // email. The fix leaves `sending_at` held so only the stale-claim timeout
    // (CLAIM_STALE_MS) can free it.
    table.push(makeRow("finalize-fail-row", { channel: "email" }));
    finalizeFailIds.add("finalize-fail-row");
    const result = await run();

    expect(vi.mocked(sendTaskReminderEmail)).toHaveBeenCalledTimes(1); // the send DID go out
    expect(result.failed).toBe(1);
    expect(result.delivered).toBe(0); // finalize threw before delivered++ ran
    const row = table.find((r) => r.id === "finalize-fail-row")!;
    expect(row.sending_at).not.toBeNull(); // claim retained — NOT released
    expect(row.fired_at).toBeNull(); // finalize stamp never landed
    expect(row.fired_status).toBeNull();
  });
});

describe("task-reminders-fire — #1581 CAS claim", () => {
  it("tryClaimReminderRow: succeeds on an unclaimed row", async () => {
    table.push(makeRow("r-1"));
    const db = makeDb();
    const claimed = await tryClaimReminderRow(db as never, "r-1", new Date().toISOString());
    expect(claimed).toBe(true);
    expect(table[0]!.sending_at).not.toBeNull();
  });

  it("tryClaimReminderRow: fails on a row with a fresh claim (concurrent run holds it)", async () => {
    table.push(makeRow("r-1", { sending_at: new Date().toISOString() }));
    const db = makeDb();
    const claimed = await tryClaimReminderRow(db as never, "r-1", new Date().toISOString());
    expect(claimed).toBe(false);
  });

  it("tryClaimReminderRow: succeeds on a row with a stale claim (crashed prior run)", async () => {
    const staleSendingAt = new Date(Date.now() - 6 * 60_000).toISOString(); // 6min old > 5min stale window
    table.push(makeRow("r-1", { sending_at: staleSendingAt }));
    const db = makeDb();
    const claimed = await tryClaimReminderRow(db as never, "r-1", new Date().toISOString());
    expect(claimed).toBe(true);
  });

  it("tryClaimReminderRow: fails on an already-fired row", async () => {
    table.push(makeRow("r-1", { fired_at: new Date().toISOString() }));
    const db = makeDb();
    const claimed = await tryClaimReminderRow(db as never, "r-1", new Date().toISOString());
    expect(claimed).toBe(false);
  });

  it("#1679: a row whose claim is lost to a concurrent run counts as skipped, not processed", async () => {
    // WHY: pre-fix, `processed` was `+= rows.length` after the loop, so it
    // counted claim-losers that were never driven to an outcome — the cron's
    // own metrics no longer reconciled, making them useless for drain-health
    // monitoring. `processed` must now equal delivered+suppressed+failed, with
    // claim-losers tallied separately as `skipped`.
    table.push(makeRow("winner-0"));
    table.push(makeRow("winner-1"));
    table.push(makeRow("loser"));
    claimFailIds.add("loser");

    const result = await run();

    expect(result.processed).toBe(2);
    expect(result.skipped).toBe(1);
    // The reconciliation invariant — this assertion fails if a future change
    // reintroduces counting a row in `processed` without an outcome.
    expect(result.delivered + result.suppressed + result.failed).toBe(result.processed);
    // The lost row was neither finalized nor claimed by this run.
    const loser = table.find((r) => r.id === "loser")!;
    expect(loser.fired_at).toBeNull();
    expect(loser.sending_at).toBeNull();
  });

  it("#1581 acceptance: two overlapping simulated runs over the same rows produce exactly one send per row", async () => {
    for (let i = 0; i < 20; i++) table.push(makeRow(`r-${i}`, { channel: "email" }));

    // Simulate overlap: kick off both runs before either finishes, by
    // running them concurrently against the same shared `table`.
    // NOTE: this exercises the app-level CAS logic (check+write is
    // synchronous per-row), but a single-thread JS mock cannot test
    // true Postgres row-locking under real concurrency. The DB-level
    // guarantee is trusted, not proven, by this test.
    const [resultA, resultB] = await Promise.all([run(), run()]);

    const totalDelivered = resultA.delivered + resultB.delivered;
    expect(totalDelivered).toBe(20);
    expect(vi.mocked(sendTaskReminderEmail)).toHaveBeenCalledTimes(20);
    expect(table.every((r) => r.fired_status === "delivered")).toBe(true);
  });
});
