// §24.9 / F-sm-01 (#1376) — enforceCustomerLimit tier decisions, fail-closed
// behaviour, and the hard-ceiling concurrency guarantee.
//
// The increment is now DB-atomic (increment_customer_chat_count RPC,
// consume-then-check). The fake Supabase client models that RPC with a
// synchronous shared counter — faithful to the real atomic INSERT … ON
// CONFLICT — so the concurrency test proves exactly one request crosses the
// hard boundary even when K land at cap-1 together.

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enforceCustomerLimit } from "@/lib/chat/customer-limit";

vi.mock("@/lib/audit/write", () => ({ writeAuditLog: vi.fn(async () => {}) }));

const USER_ID = "user-1";
const TENANT_ID = "tenant-1";
const CAPS = { soft1_cap: 20, soft2_cap: 30, hard_cap: 40, booking_bonus_percent: 0 };

type Opts = {
  // increment_customer_chat_count behaviour:
  fixedPost?: number; // constant post-increment count
  startCount?: number; // stateful: each call returns ++ from here (concurrency)
  incError?: { message: string } | null;
  // meta (soft cooldown) read:
  soft1LastAt?: string | null;
  soft2LastAt?: string | null;
  metaError?: { message: string } | null;
};

function makeDb(opts: Opts): SupabaseClient {
  let counter = opts.startCount ?? 0;
  const counterRow = {
    select: (cols: string) => {
      // The only customer_chat_counters SELECT is the soft-cooldown read.
      if (cols.includes("soft1_last_issued_at")) {
        return {
          eq: () => ({
            eq: () => ({
              maybeSingle: async () =>
                opts.metaError
                  ? { data: null, error: opts.metaError }
                  : {
                      data: {
                        soft1_last_issued_at: opts.soft1LastAt ?? null,
                        soft2_last_issued_at: opts.soft2LastAt ?? null,
                      },
                      error: null,
                    },
            }),
          }),
        };
      }
      throw new Error("unexpected select cols: " + cols);
    },
    update: () => ({
      eq: () => ({
        eq: () => ({
          then: (r: (v: { data: null; error: null }) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(r),
        }),
      }),
    }),
  };
  return {
    rpc: async (fn: string) => {
      if (fn === "resolve_customer_chat_caps") return { data: [CAPS], error: null };
      if (fn === "increment_customer_chat_count") {
        if (opts.incError) return { data: null, error: opts.incError };
        if (opts.fixedPost !== undefined) return { data: opts.fixedPost, error: null };
        counter += 1;
        return { data: counter, error: null };
      }
      throw new Error("unexpected rpc: " + fn);
    },
    from: (table: string) => {
      if (table === "customer_chat_counters") return counterRow as unknown as ReturnType<SupabaseClient["from"]>;
      if (table === "platform_settings") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { value: "nudge" }, error: null }) }),
          }),
        } as unknown as ReturnType<SupabaseClient["from"]>;
      }
      throw new Error("unexpected table: " + table);
    },
  } as unknown as SupabaseClient;
}

describe("enforceCustomerLimit — tier decisions (consume-then-check)", () => {
  it("below tier when post-increment count is under soft1_cap", async () => {
    const r = await enforceCustomerLimit(makeDb({ fixedPost: 5 }), { user_id: USER_ID, tenant_id: TENANT_ID });
    expect(r.tier).toBe("below");
    expect(r.current_count).toBe(5);
  });

  it("soft1 at soft1_cap (no cooldown active)", async () => {
    const r = await enforceCustomerLimit(makeDb({ fixedPost: 20, soft1LastAt: null }), { user_id: USER_ID, tenant_id: TENANT_ID });
    expect(r.tier).toBe("soft1");
  });

  it("soft2 at soft2_cap (no cooldown active)", async () => {
    const r = await enforceCustomerLimit(makeDb({ fixedPost: 30, soft2LastAt: null }), { user_id: USER_ID, tenant_id: TENANT_ID });
    expect(r.tier).toBe("soft2");
  });

  it("hard once the consumed count exceeds hard_cap", async () => {
    const r = await enforceCustomerLimit(makeDb({ fixedPost: 41 }), { user_id: USER_ID, tenant_id: TENANT_ID });
    expect(r.tier).toBe("hard");
  });

  it("boundary: exactly hard_cap is NOT hard (the last allowed message)", async () => {
    const r = await enforceCustomerLimit(makeDb({ fixedPost: 40, soft2LastAt: null }), { user_id: USER_ID, tenant_id: TENANT_ID });
    expect(r.tier).not.toBe("hard");
  });
});

describe("enforceCustomerLimit — fail-closed", () => {
  it("throws when the atomic increment RPC errors (not silently allowed)", async () => {
    await expect(
      enforceCustomerLimit(makeDb({ incError: { message: "PG timeout" } }), { user_id: USER_ID, tenant_id: TENANT_ID }),
    ).rejects.toThrow(/increment_customer_chat_count failed/);
  });

  it("throws when the cooldown-meta read errors", async () => {
    await expect(
      enforceCustomerLimit(makeDb({ fixedPost: 5, metaError: { message: "PG timeout" } }), { user_id: USER_ID, tenant_id: TENANT_ID }),
    ).rejects.toThrow(/customer_chat_counters\.read failed/);
  });
});

describe("enforceCustomerLimit — hard-ceiling concurrency (F-sm-01)", () => {
  it("K parallel calls at hard_cap-1 → exactly one non-hard return", async () => {
    // startCount=39 (hard_cap-1). 10 parallel; the atomic RPC hands out distinct
    // post-counts 40,41,…,49 — only 40 is non-hard.
    const db = makeDb({ startCount: 39, soft2LastAt: null });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => enforceCustomerLimit(db, { user_id: USER_ID, tenant_id: TENANT_ID })),
    );
    expect(results.filter((r) => r.tier !== "hard").length).toBe(1);
  });
});
