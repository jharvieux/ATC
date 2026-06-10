// #900 — task-reminders-fire drain loop.
//
// Verifies that a backlog larger than BATCH_LIMIT (200) is fully drained
// within a single run. Without the drain loop, only the first 200 rows
// would be processed, and the rest would silently accumulate.

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
type PoolRow = { id: string; tenant_id: string; task_id: string; channel: "in_app"; remind_at: string; tasks: { snoozed_until: null; assigned_to_user_id: null; status: "open"; title: string } };
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
          // then() is called by the Supabase select chain
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

function makeRow(id: string) {
  return {
    id,
    tenant_id: "t-1",
    task_id: `task-${id}`,
    channel: "in_app" as const,
    remind_at: new Date(Date.now() - 1000).toISOString(),
    tasks: { snoozed_until: null, assigned_to_user_id: null, status: "open" as const, title: "Test task" },
  };
}

import { taskRemindersFire } from "@/inngest/task-reminders-fire";

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
