// #1789 — per-(user_id, tenant_id) recompute was parallelized via
// mapWithConcurrency (previously one row at a time). The risk that matters
// is attribution: each row's recomputed message count must be written back
// to THAT row, not a different one that happened to finish around the same
// time. This pins correct attribution across concurrently-resolving rows,
// including two different users within the SAME tenant (same tenant_id,
// different user_id — the closest case to an accidental cross-write).
//
// #1975 — the recompute write is now a CAS on last_message_at: the atomic
// increment_customer_chat_count RPC bumps last_message_at on every live
// increment, so a recompute whose snapshot predates a concurrent increment
// must match zero rows and skip, leaving the increment's fresh count intact.
//
// #1994 — the row list itself is paged with .range() instead of a single
// .limit(5000): PostgREST's db-max-rows can cap a single request below that,
// silently dropping every row past the cap from the nightly drift correction.
// This pins that a table spanning more than one page still gets every row
// recomputed.

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_config: unknown, handler: unknown) => ({ __handler: handler }),
  },
}));

interface Counter {
  user_id: string;
  tenant_id: string;
  current_count: number | null;
  last_message_at: string | null;
}

let counters: Counter[];
let messageCountFor: Record<string, number>; // key: `${user_id}:${tenant_id}`
let messageCountError: Record<string, boolean>; // key: `${user_id}:${tenant_id}` — simulate a transient count failure
let incrementDuringCount: Record<string, () => void>; // key → a concurrent increment that lands mid-recompute (after the count read, before the write)

vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: async (p: Promise<{ data: unknown; error: unknown }>) => {
    const { data, error } = await p;
    if (error) throw new Error(String(error));
    return data;
  },
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      if (table === "customer_chat_counters") {
        const filters: Record<string, string | null> = {};
        let payload: { current_count: number };
        const applyCas = () => {
          const row = counters.find(
            (c) => c.user_id === filters.user_id && c.tenant_id === filters.tenant_id,
          );
          // Model Postgres faithfully: an UPDATE with a last_message_at
          // predicate writes only when it matches (CAS); without that predicate
          // it writes unconditionally (the old blind overwrite). So a build
          // that drops the guard still clobbers here — which is what the #1975
          // race test must catch.
          const hasCas = "last_message_at" in filters;
          if (row && (!hasCas || row.last_message_at === filters.last_message_at)) {
            row.current_count = payload.current_count;
            return [{ user_id: row.user_id }];
          }
          return [];
        };
        const builder = {
          eq(col: string, val: string) {
            filters[col] = val;
            return builder;
          },
          is(col: string, val: null) {
            filters[col] = val;
            return builder;
          },
          select() {
            return Promise.resolve({ data: applyCas(), error: null });
          },
        };
        return {
          select: () => {
            // .order().order().range(from, to) — mirrors the paginated row
            // list. Copies rows: PostgREST returns a deserialized snapshot,
            // not the live store, so a concurrent increment can't
            // retroactively edit the value the recompute already read.
            const pageBuilder = {
              order: () => pageBuilder,
              range: (from: number, to: number) =>
                Promise.resolve({
                  data: counters.slice(from, to + 1).map((c) => ({ ...c })),
                  error: null,
                }),
            };
            return pageBuilder;
          },
          update(p: { current_count: number }) {
            payload = p;
            return builder;
          },
        };
      }
      // messages — count query keyed off conversations.user_id/tenant_id.
      const filters: Record<string, string> = {};
      const chain = {
        select: () => chain,
        eq(col: string, val: string) {
          if (col === "conversations.user_id") filters.user_id = val;
          if (col === "conversations.tenant_id") filters.tenant_id = val;
          return chain;
        },
        gte: () => chain,
        then(resolve: (v: unknown) => unknown) {
          const key = `${filters.user_id}:${filters.tenant_id}`;
          const count = messageCountFor[key] ?? 0;
          // Stagger resolution so rows genuinely interleave under concurrency;
          // also give any injected concurrent-increment hook a beat to land
          // between the count read and the recompute write.
          const delayMs = filters.user_id === "u-1" || incrementDuringCount[key] ? 10 : 0;
          return Promise.resolve().then(async () => {
            if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
            // A live increment_customer_chat_count call landing mid-recompute:
            // it bumps current_count and last_message_at before our write.
            incrementDuringCount[key]?.();
            if (messageCountError[key]) {
              resolve({ data: null, count: null, error: { message: "count failed" } });
              return;
            }
            // count: "exact", head: true — PostgREST returns the count, no rows.
            resolve({ data: null, count, error: null });
          });
        },
      };
      return chain;
    },
  }),
}));

async function runCron(): Promise<unknown> {
  vi.resetModules();
  const mod = (await import("@/inngest/customer-chat-counter-recompute")) as unknown as {
    customerChatCounterRecompute: { __handler: () => Promise<unknown> };
  };
  return mod.customerChatCounterRecompute.__handler();
}

const T0 = "2026-07-16T00:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  messageCountError = {};
  incrementDuringCount = {};
});

describe("customerChatCounterRecompute — concurrent per-row attribution (#1789)", () => {
  it("writes each row's recomputed count back to that same row, not a differently-timed one", async () => {
    counters = [
      { user_id: "u-1", tenant_id: "t-1", current_count: 0, last_message_at: T0 }, // slow resolver
      { user_id: "u-2", tenant_id: "t-1", current_count: 0, last_message_at: T0 }, // same tenant, different user
      { user_id: "u-3", tenant_id: "t-2", current_count: 0, last_message_at: T0 },
    ];
    messageCountFor = {
      "u-1:t-1": 7,
      "u-2:t-1": 3,
      "u-3:t-2": 1,
    };

    const result = (await runCron()) as { processed: number };
    expect(result).toEqual({ processed: 3 });

    const byUser = Object.fromEntries(counters.map((c) => [c.user_id, c.current_count]));
    expect(byUser).toEqual({ "u-1": 7, "u-2": 3, "u-3": 1 });
  });

  it("#1956 — a user with more than 1000 messages in the window gets an accurate current_count, not capped at 1000", async () => {
    counters = [{ user_id: "u-heavy", tenant_id: "t-1", current_count: 0, last_message_at: T0 }];
    messageCountFor = { "u-heavy:t-1": 1547 };

    await runCron();

    expect(counters[0]!.current_count).toBe(1547);
  });

  it("skips the write for a row whose count query errors, leaving its counter untouched, while other rows still process", async () => {
    counters = [
      { user_id: "u-err", tenant_id: "t-1", current_count: 42, last_message_at: T0 },
      { user_id: "u-ok", tenant_id: "t-1", current_count: 0, last_message_at: T0 },
    ];
    messageCountFor = { "u-ok:t-1": 5 };
    messageCountError = { "u-err:t-1": true };

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = (await runCron()) as { processed: number };
    expect(result).toEqual({ processed: 2 });

    const byUser = Object.fromEntries(counters.map((c) => [c.user_id, c.current_count]));
    // u-err's counter must stay at its prior value (42), not fall through to
    // `?? 0` and zero out a heavy user's cap for the rest of the window.
    expect(byUser).toEqual({ "u-err": 42, "u-ok": 5 });

    consoleErrorSpy.mockRestore();
  });
});

describe("customerChatCounterRecompute — CAS vs concurrent increment (#1975)", () => {
  it("does not clobber a live increment_customer_chat_count that lands during the recompute window", async () => {
    // The recompute read 5 messages a moment ago. While it was counting, the
    // customer sent one more message: the atomic RPC bumped current_count to 6
    // and moved last_message_at forward. The recompute's blind overwrite would
    // have written its stale 5 back, undercounting the customer for the whole
    // window (letting them exceed their cap). WHY this matters: the increment
    // is the cap-enforcement write; it must always win a race with the
    // best-effort drift recompute.
    counters = [
      { user_id: "u-race", tenant_id: "t-1", current_count: 5, last_message_at: T0 },
    ];
    messageCountFor = { "u-race:t-1": 5 };
    incrementDuringCount = {
      "u-race:t-1": () => {
        const row = counters[0]!;
        row.current_count = 6;
        row.last_message_at = "2026-07-16T04:30:05.000Z"; // NOW() from the RPC
      },
    };

    const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const result = (await runCron()) as { processed: number };
    expect(result).toEqual({ processed: 1 });

    // The increment's fresh count survives; the recompute skipped (CAS miss).
    expect(counters[0]!.current_count).toBe(6);
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      "[customer-chat-counter-recompute] concurrent increment, skipping row",
      expect.objectContaining({ user_id: "u-race", tenant_id: "t-1" }),
    );

    consoleInfoSpy.mockRestore();
  });

  it("applies the recompute when no increment races (last_message_at unchanged)", async () => {
    // The drift-correction path must still work: with no concurrent increment,
    // the snapshot still matches and the corrected count is written.
    counters = [
      { user_id: "u-quiet", tenant_id: "t-1", current_count: 99, last_message_at: T0 },
    ];
    messageCountFor = { "u-quiet:t-1": 12 };

    await runCron();

    expect(counters[0]!.current_count).toBe(12);
  });

  it("applies the recompute for a row whose last_message_at is still null (no increment has ever landed)", async () => {
    // Rows are only ever created by increment_customer_chat_count, which sets
    // last_message_at — but the CAS falls back to `.is(..., null)` defensively.
    // With no concurrent increment, that null snapshot still matches and the
    // recomputed count is written.
    counters = [
      { user_id: "u-null", tenant_id: "t-1", current_count: 0, last_message_at: null },
    ];
    messageCountFor = { "u-null:t-1": 8 };

    await runCron();

    expect(counters[0]!.current_count).toBe(8);
  });

  it("skips the write when a concurrent increment sets last_message_at from null mid-recompute", async () => {
    // Same race as the T0 case above, but starting from a null snapshot: the
    // increment's `.is("last_message_at", null)` match window closes the
    // moment it bumps the timestamp, so the recompute's null-guarded CAS must
    // miss and the increment's fresh count must survive.
    counters = [
      { user_id: "u-null-race", tenant_id: "t-1", current_count: 0, last_message_at: null },
    ];
    messageCountFor = { "u-null-race:t-1": 8 };
    incrementDuringCount = {
      "u-null-race:t-1": () => {
        const row = counters[0]!;
        row.current_count = 1;
        row.last_message_at = "2026-07-16T04:30:05.000Z"; // NOW() from the RPC
      },
    };

    const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const result = (await runCron()) as { processed: number };
    expect(result).toEqual({ processed: 1 });

    expect(counters[0]!.current_count).toBe(1);
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      "[customer-chat-counter-recompute] concurrent increment, skipping row",
      expect.objectContaining({ user_id: "u-null-race", tenant_id: "t-1" }),
    );

    consoleInfoSpy.mockRestore();
  });
});

describe("customerChatCounterRecompute — row-list pagination (#1994)", () => {
  it("recomputes every row when the table spans more than one page, not just the first 1000", async () => {
    // One row past the page size forces a second .range() fetch. Before the
    // fix, a single .limit(5000) call relied on PostgREST returning up to
    // 5000 rows unordered and uncapped by db-max-rows — if the server's
    // actual max-rows setting is at or below the table size, rows past the
    // cap were silently never recomputed, forever.
    const rowCount = 1001;
    counters = Array.from({ length: rowCount }, (_, i) => ({
      user_id: `u-${String(i).padStart(4, "0")}`,
      tenant_id: "t-1",
      current_count: 0,
      last_message_at: T0,
    }));
    messageCountFor = Object.fromEntries(counters.map((c) => [`${c.user_id}:t-1`, 1]));

    const result = (await runCron()) as { processed: number };

    expect(result).toEqual({ processed: rowCount });
    expect(counters.every((c) => c.current_count === 1)).toBe(true);
  });
});
