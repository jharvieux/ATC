// BP32 §32.11.4 — per-customer rate limit tests.
//
// Mocks the Supabase client to walk the counter through 5 successful
// submissions + the 6th refusal, and verifies a quarantined submission
// (the caller skips recordCustomerBugSubmission) doesn't count.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkCustomerBugLimit,
  recordCustomerBugSubmission,
  getPoliteRefusalMessage,
} from "@/lib/help-ai/customer-rate-limit";

const ORIGINAL_ENV = process.env;

interface CounterRow {
  id: string;
  user_id: string;
  tenant_id: string;
  day_anchor: string;
  submission_count: number;
  last_submission_at: string | null;
}

function mockDbForCounter(state: { rows: CounterRow[] }): SupabaseClient {
  // Highly stylized — supports only the (.from('customer_bug_submission_counters'))
  // chain shape this lib uses: select/eq/eq/eq/maybeSingle, update/eq, insert.
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_c1: string, v1: string) => ({
          eq: (_c2: string, v2: string) => ({
            eq: (_c3: string, v3: string) => ({
              maybeSingle: async () => {
                const row = state.rows.find(
                  (r) => r.user_id === v1 && r.tenant_id === v2 && r.day_anchor === v3,
                );
                return { data: row ?? null };
              },
            }),
          }),
        }),
      }),
      update: (patch: Partial<CounterRow>) => ({
        eq: async (_c: string, id: string) => {
          const idx = state.rows.findIndex((r) => r.id === id);
          if (idx >= 0) state.rows[idx] = { ...state.rows[idx]!, ...patch };
          return { error: null };
        },
      }),
      insert: async (payload: Omit<CounterRow, "id">) => {
        state.rows.push({ ...payload, id: `row-${state.rows.length + 1}` });
        return { error: null };
      },
    }),
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV, CUSTOMER_BUG_PER_DAY_LIMIT: "5" };
});

describe("checkCustomerBugLimit", () => {
  it("allows the first submission and reports count_today=0, limit=5", async () => {
    const state = { rows: [] as CounterRow[] };
    const db = mockDbForCounter(state);
    const r = await checkCustomerBugLimit(db, "user-1", "tenant-1");
    expect(r.allowed).toBe(true);
    expect(r.count_today).toBe(0);
    expect(r.limit).toBe(5);
  });

  it("walks 5 submissions then refuses the 6th", async () => {
    const state = { rows: [] as CounterRow[] };
    const db = mockDbForCounter(state);
    for (let i = 0; i < 5; i++) {
      const r = await checkCustomerBugLimit(db, "user-1", "tenant-1");
      expect(r.allowed).toBe(true);
      await recordCustomerBugSubmission(db, "user-1", "tenant-1");
    }
    const sixth = await checkCustomerBugLimit(db, "user-1", "tenant-1");
    expect(sixth.allowed).toBe(false);
    expect(sixth.count_today).toBe(5);
  });

  it("respects custom CUSTOMER_BUG_PER_DAY_LIMIT", async () => {
    process.env.CUSTOMER_BUG_PER_DAY_LIMIT = "2";
    vi.resetModules();
    const { checkCustomerBugLimit: check2, recordCustomerBugSubmission: rec2 } = await import(
      "@/lib/help-ai/customer-rate-limit"
    );
    const state = { rows: [] as CounterRow[] };
    const db = mockDbForCounter(state);
    expect((await check2(db, "u", "t")).allowed).toBe(true);
    await rec2(db, "u", "t");
    expect((await check2(db, "u", "t")).allowed).toBe(true);
    await rec2(db, "u", "t");
    expect((await check2(db, "u", "t")).allowed).toBe(false);
  });

  it("quarantine does NOT count (caller doesn't invoke recordCustomerBugSubmission)", async () => {
    const state = { rows: [] as CounterRow[] };
    const db = mockDbForCounter(state);
    // First call: under limit. Simulate quarantine — don't call record.
    expect((await checkCustomerBugLimit(db, "u", "t")).allowed).toBe(true);
    // 5 more attempts can still proceed because nothing was recorded.
    for (let i = 0; i < 5; i++) {
      expect((await checkCustomerBugLimit(db, "u", "t")).allowed).toBe(true);
      await recordCustomerBugSubmission(db, "u", "t");
    }
    expect((await checkCustomerBugLimit(db, "u", "t")).allowed).toBe(false);
  });

  it("polite refusal message matches §32.11.4", () => {
    const msg = getPoliteRefusalMessage();
    expect(msg).toMatch(/already.*today|today already/i);
    expect(msg).toMatch(/try again tomorrow/i);
  });
});
