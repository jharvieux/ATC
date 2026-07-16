// #1789 — per-(user_id, tenant_id) recompute was parallelized via
// mapWithConcurrency (previously one row at a time). The risk that matters
// is attribution: each row's recomputed message count must be written back
// to THAT row, not a different one that happened to finish around the same
// time. This pins correct attribution across concurrently-resolving rows,
// including two different users within the SAME tenant (same tenant_id,
// different user_id — the closest case to an accidental cross-write).

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
}

let counters: Counter[];
let messageCountFor: Record<string, number>; // key: `${user_id}:${tenant_id}`

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
        const filters: Record<string, string> = {};
        return {
          select: () => ({
            limit: () => Promise.resolve({ data: counters, error: null }),
          }),
          update(payload: { current_count: number }) {
            return {
              eq(col: string, val: string) {
                filters[col] = val;
                return {
                  eq: (col2: string, val2: string) => {
                    filters[col2] = val2;
                    const row = counters.find(
                      (c) => c.user_id === filters.user_id && c.tenant_id === filters.tenant_id,
                    );
                    if (row) row.current_count = payload.current_count;
                    return Promise.resolve({ data: null, error: null });
                  },
                };
              },
            };
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
          // Stagger resolution so rows genuinely interleave under concurrency.
          const delayMs = filters.user_id === "u-1" ? 10 : 0;
          return Promise.resolve().then(async () => {
            if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
            resolve({ data: Array.from({ length: count }, (_, i) => ({ id: `m-${i}` })), error: null });
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("customerChatCounterRecompute — concurrent per-row attribution (#1789)", () => {
  it("writes each row's recomputed count back to that same row, not a differently-timed one", async () => {
    counters = [
      { user_id: "u-1", tenant_id: "t-1", current_count: 0 }, // slow resolver
      { user_id: "u-2", tenant_id: "t-1", current_count: 0 }, // same tenant, different user
      { user_id: "u-3", tenant_id: "t-2", current_count: 0 },
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
});
