// #900 — task-reminders-fire drain loop.
//
// Covers:
//   - Drain loop: a backlog > BATCH_LIMIT is fully drained in one run.
//   - §37.3.3 snooze suppression: remind_at < snoozed_until → status=suppressed.
//   - Email channel: sendTaskReminderEmail called, status=delivered.
//   - Per-row failure: safeAwait throws → failed++ without aborting the run.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, handler: () => Promise<unknown>) => handler,
  },
}));

vi.mock("@/lib/tasks/send-reminder-email", () => ({
  sendTaskReminderEmail: vi.fn(async () => ({ status: "sent" })),
}));

vi.mock("@/lib/db/safe-mutation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/safe-mutation")>("@/lib/db/safe-mutation");
  return { ...actual, safeAwait: vi.fn(async (p: Promise<unknown>) => p) };
});

// The DB mock returns rows from `pool` in BATCH_LIMIT-sized pages.
// Each SELECT drains the front of the pool; UPDATE is a no-op.
const BATCH_LIMIT = 200;
type PoolRow = {
  id: string;
  tenant_id: string;
  task_id: string;
  channel: "in_app" | "email";
  remind_at: string;
  tasks: { snoozed_until: string | null; assigned_to_user_id: null; status: "open"; title: string };
};
const pool: PoolRow[] = [];

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      if (table === "task_reminders") {
        const selectBuilder = {
          _limit: BATCH_LIMIT,
          select() { return this; },
          is() { return this; },
          lte() { return this; },
          limit(n: number) { this._limit = n; return this; },
          eq() { return { then: (r: (v: { error: null }) => unknown) => Promise.resolve(r({ error: null })) }; },
          update() { return this; },
          // Supabase builders are thenables — Promise.resolve() calls .then() to settle them.
          then(resolve: (v: { data: typeof pool; error: null }) => unknown) {
            const batch = pool.splice(0, this._limit);
            return Promise.resolve(resolve({ data: batch, error: null }));
          },
        };
        return selectBuilder;
      }
      return {
        select() { return this; },
        update() { return this; },
        eq() { return { then: (r: (v: { error: null }) => unknown) => Promise.resolve(r({ error: null })) }; },
      };
    },
  }),
}));

function makeRow(id: string, overrides: Partial<PoolRow> = {}): PoolRow {
  return {
    id,
    tenant_id: "t-1",
    task_id: `task-${id}`,
    channel: "in_app",
    remind_at: new Date(Date.now() - 1000).toISOString(),
    tasks: { snoozed_until: null, assigned_to_user_id: null, status: "open", title: "Test task" },
    ...overrides,
  };
}

import { taskRemindersFire } from "@/inngest/task-reminders-fire";
import { sendTaskReminderEmail } from "@/lib/tasks/send-reminder-email";
import { safeAwait } from "@/lib/db/safe-mutation";

type FireResult = { processed: number; delivered: number; suppressed: number; failed: number; batches: number };
const run = taskRemindersFire as unknown as () => Promise<FireResult>;

beforeEach(() => {
  pool.length = 0;
  vi.clearAllMocks();
});

describe("task-reminders-fire — drain loop (#900)", () => {
  it("single batch: processes all rows and reports batches=1", async () => {
    for (let i = 0; i < 50; i++) pool.push(makeRow(`r-${i}`));
    const result = await run();
    expect(result.processed).toBe(50);
    expect(result.batches).toBe(1);
  });

  it("#900: multi-batch: drains a pool of BATCH_LIMIT+1 rows in 2 batches", async () => {
    for (let i = 0; i < BATCH_LIMIT + 1; i++) pool.push(makeRow(`r-${i}`));
    const result = await run();
    expect(result.processed).toBe(BATCH_LIMIT + 1);
    expect(result.batches).toBe(2);
    expect(pool).toHaveLength(0);
  });

  it("empty pool: processes 0 rows in 1 batch", async () => {
    const result = await run();
    expect(result.processed).toBe(0);
    expect(result.batches).toBe(1);
  });

  it("exactly BATCH_LIMIT rows: exits after 2 fetches (second returns empty)", async () => {
    for (let i = 0; i < BATCH_LIMIT; i++) pool.push(makeRow(`r-${i}`));
    const result = await run();
    expect(result.processed).toBe(BATCH_LIMIT);
    // First batch full (200) → re-queries; second batch empty (0) → breaks.
    expect(result.batches).toBe(2);
  });
});

describe("task-reminders-fire — per-row behaviors", () => {
  it("§37.3.3: snooze suppression — remind_at inside snoozed_until window → suppressed=1, delivered=0", async () => {
    const remindAt = new Date(Date.now() - 1000).toISOString();
    const snoozedUntil = new Date(Date.now() + 60_000).toISOString();
    pool.push(makeRow("snoozed", {
      remind_at: remindAt,
      tasks: { snoozed_until: snoozedUntil, assigned_to_user_id: null, status: "open", title: "Snoozed task" },
    }));
    const result = await run();
    expect(result.suppressed).toBe(1);
    expect(result.delivered).toBe(0);
    expect(vi.mocked(sendTaskReminderEmail)).not.toHaveBeenCalled();
  });

  it("email channel: sendTaskReminderEmail called → delivered=1", async () => {
    pool.push(makeRow("email-row", { channel: "email" }));
    const result = await run();
    expect(vi.mocked(sendTaskReminderEmail)).toHaveBeenCalledTimes(1);
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("per-row DB error: safeAwait throws for one row → failed=1, run continues", async () => {
    // The try/catch inside the loop catches safeAwait errors so a single
    // row's DB failure doesn't abort the rest of the batch.
    pool.push(makeRow("good"), makeRow("bad"), makeRow("good2"));
    vi.mocked(safeAwait)
      .mockResolvedValueOnce(undefined)   // good row
      .mockRejectedValueOnce(new Error("DB write error"))  // bad row
      .mockResolvedValueOnce(undefined);  // good2 row
    const result = await run();
    expect(result.processed).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.delivered).toBe(2);
  });
});
