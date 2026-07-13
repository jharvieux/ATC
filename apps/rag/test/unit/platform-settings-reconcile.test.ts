// #1885 — platform-settings-reconcile had zero unit coverage after #1884's
// sequential-loop → mapWithConcurrency refactor. Pins: per-key outcome
// tallies, that a single row's DB error aborts the whole sweep (mirrors the
// same fail-loud behavior openai-embedding-reconcile.test.ts pins — see
// "aborts before any status flip when a chunk write fails" there;
// mapWithConcurrency has no per-item catch, so one rejection fails the
// Promise.all for the whole wave), and that a >concurrency fan-out neither
// drops nor double-processes a key.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (config: unknown, handler: unknown) => ({ config, handler }),
  },
}));

interface ShadowRow {
  key: string;
  value: unknown;
  source_revision: number;
  last_reconcile_sync_at?: string;
}

interface State {
  rows: ShadowRow[];
}

// Fluent mock over the in-memory shadow table. Supports exactly the chains
// platform-settings-reconcile.ts uses: select (no filter), insert, and
// update().eq("key", ...).
function makeDb(state: State, opts: { failFor?: Set<string> } = {}) {
  return {
    from(table: string) {
      if (table !== "platform_settings") throw new Error(`unexpected table ${table}`);
      const filters: Array<[string, unknown]> = [];
      let op: "select" | "insert" | "update" = "select";
      let payload: Record<string, unknown> | null = null;

      const matches = (r: ShadowRow) =>
        filters.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v);

      const run = () => {
        if (op === "select") {
          return { data: state.rows, error: null };
        }
        const keyFilter = filters.find(([c]) => c === "key")?.[1] as string | undefined;
        const targetKey = op === "insert" ? (payload as Record<string, unknown>).key as string : keyFilter;
        if (targetKey && opts.failFor?.has(targetKey)) {
          return { data: null, error: { message: "simulated write failure", code: "XX000" } };
        }
        if (op === "insert") {
          state.rows.push({ ...(payload as Record<string, unknown>) } as unknown as ShadowRow);
          return { data: null, error: null };
        }
        // update
        for (const r of state.rows.filter(matches)) Object.assign(r, payload);
        return { data: null, error: null };
      };

      const chain: Record<string, unknown> = {
        select(_c?: string) {
          return chain;
        },
        insert(p: Record<string, unknown>) {
          op = "insert";
          payload = p;
          return chain;
        },
        update(p: Record<string, unknown>) {
          op = "update";
          payload = p;
          return chain;
        },
        eq(c: string, v: unknown) {
          filters.push([c, v]);
          return chain;
        },
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve(resolve(run()));
        },
      };
      return chain;
    },
  };
}

let currentDb: ReturnType<typeof makeDb>;
vi.mock("@/lib/db/supabase", () => ({
  getRagDb: () => currentDb,
}));

const mainAppUrl = "https://main.example.com";

function mockMainSettings(settings: Array<{ key: string; value: unknown; source_revision: number }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      type: "default",
      json: async () => ({
        settings: settings.map((s) => ({ ...s, updated_at: "2026-07-01T00:00:00Z" })),
      }),
    }),
  );
}

async function runReconcile(): Promise<unknown> {
  vi.resetModules();
  const { platformSettingsReconcile } = await import("@/inngest/platform-settings-reconcile");
  const fn = platformSettingsReconcile as unknown as { handler: () => Promise<unknown> };
  return fn.handler();
}

beforeEach(() => {
  process.env.MAIN_APP_URL = mainAppUrl;
  process.env.MAIN_APP_ADMIN_API_KEY = "test-admin-key";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// Only 4 keys are sync-eligible (SYNC_ELIGIBLE_KEYS): feedback_adjustment_limit,
// feedback_min_signal_count, feedback_period_days, feedback_decay_halflife_days.

describe("#1885 — platform-settings-reconcile outcome tallies", () => {
  it("tallies insert/update/unchanged/skipped_not_eligible correctly per key", async () => {
    mockMainSettings([
      // absent from shadow → insert
      { key: "feedback_adjustment_limit", value: 5, source_revision: 3 },
      // present, drifted, main is newer → update
      { key: "feedback_min_signal_count", value: 10, source_revision: 2 },
      // present, identical → unchanged (still touches last_reconcile_sync_at)
      { key: "feedback_period_days", value: 30, source_revision: 1 },
      // not in the sync-eligible allowlist → skipped
      { key: "some_other_setting", value: "x", source_revision: 1 },
    ]);
    currentDb = makeDb({
      rows: [
        { key: "feedback_min_signal_count", value: 5, source_revision: 1 },
        { key: "feedback_period_days", value: 30, source_revision: 1 },
      ],
    });

    const result = await runReconcile();

    expect(result).toEqual({ inserted: 1, updated: 1, skipped_not_eligible: 1 });
  });

  it("inserts a genuinely-missing key with the main-side value and revision", async () => {
    mockMainSettings([{ key: "feedback_adjustment_limit", value: 5, source_revision: 3 }]);
    const state: State = { rows: [] };
    currentDb = makeDb(state);

    const result = await runReconcile();

    expect(result).toEqual({ inserted: 1, updated: 0, skipped_not_eligible: 0 });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ key: "feedback_adjustment_limit", value: 5, source_revision: 3 });
  });

  it("does not touch shadow value/source_revision when unchanged (still stamps last_reconcile_sync_at)", async () => {
    mockMainSettings([{ key: "feedback_period_days", value: 30, source_revision: 1 }]);
    const state: State = {
      rows: [{ key: "feedback_period_days", value: 30, source_revision: 1 }],
    };
    currentDb = makeDb(state);

    const result = await runReconcile();

    expect(result).toEqual({ inserted: 0, updated: 0, skipped_not_eligible: 0 });
    expect(state.rows[0]!.value).toBe(30);
    expect(state.rows[0]!.source_revision).toBe(1);
    expect(state.rows[0]!.last_reconcile_sync_at).toBeDefined();
  });

  it("re-running with no drift produces the same tallies (idempotent)", async () => {
    mockMainSettings([
      { key: "feedback_adjustment_limit", value: 5, source_revision: 3 },
      { key: "feedback_min_signal_count", value: 10, source_revision: 2 },
    ]);
    const state: State = {
      rows: [
        { key: "feedback_adjustment_limit", value: 5, source_revision: 3 },
        { key: "feedback_min_signal_count", value: 10, source_revision: 2 },
      ],
    };
    currentDb = makeDb(state);

    const first = await runReconcile();
    expect(first).toEqual({ inserted: 0, updated: 0, skipped_not_eligible: 0 });
    expect(state.rows).toHaveLength(2);

    currentDb = makeDb(state);
    const second = await runReconcile();
    expect(second).toEqual({ inserted: 0, updated: 0, skipped_not_eligible: 0 });
    // No duplicate rows created by re-running against unchanged state.
    expect(state.rows).toHaveLength(2);
  });
});

describe("#1885 — platform-settings-reconcile error isolation", () => {
  it("pins ACTUAL behavior: one key's DB write failure rejects the whole sweep (no per-key isolation)", async () => {
    // mapWithConcurrency (apps/rag/src/lib/async/with-concurrency.ts) has no
    // per-item try/catch — a single fn() rejection fails the shared
    // Promise.all, so the entire reconcile throws instead of returning a
    // partial tally. This mirrors the accepted design documented in
    // openai-embedding-reconcile.test.ts ("aborts before any status flip
    // when a chunk write fails") — no per-key isolation is intended here,
    // and there is no pending decision to make.
    mockMainSettings([
      { key: "feedback_adjustment_limit", value: 5, source_revision: 3 }, // will fail
      { key: "feedback_min_signal_count", value: 99, source_revision: 9 }, // would otherwise succeed
    ]);
    currentDb = makeDb(
      { rows: [{ key: "feedback_min_signal_count", value: 1, source_revision: 1 }] },
      { failFor: new Set(["feedback_adjustment_limit"]) },
    );

    await expect(runReconcile()).rejects.toThrow();
  });
});

describe("#1885 — platform-settings-reconcile concurrency fan-out correctness", () => {
  it("processes every sync-eligible key exactly once when the key count exceeds RECONCILE_CONCURRENCY (10)", async () => {
    // 4 sync-eligible keys total (allowlist is fixed size) is fewer than the
    // concurrency bound, so pad the main-side payload with 20 non-eligible
    // keys to force multiple worker waves through mapWithConcurrency and
    // verify none of the eligible keys are dropped or double-applied.
    const eligibleKeys = [
      "feedback_adjustment_limit",
      "feedback_min_signal_count",
      "feedback_period_days",
      "feedback_decay_halflife_days",
    ];
    const paddingKeys = Array.from({ length: 20 }, (_, i) => `padding_key_${i}`);
    const allKeys = [...eligibleKeys, ...paddingKeys];
    mockMainSettings(allKeys.map((key, i) => ({ key, value: i, source_revision: i + 1 })));
    const state: State = { rows: [] };
    currentDb = makeDb(state);

    const result = await runReconcile();

    expect(result).toEqual({ inserted: 4, updated: 0, skipped_not_eligible: 20 });
    // Exactly one shadow row per eligible key — no duplicate inserts from a
    // double-processed key, and no eligible key silently dropped.
    expect(state.rows).toHaveLength(4);
    expect(state.rows.map((r) => r.key).sort()).toEqual([...eligibleKeys].sort());
    for (const key of eligibleKeys) {
      expect(state.rows.filter((r) => r.key === key)).toHaveLength(1);
    }
  });
});
