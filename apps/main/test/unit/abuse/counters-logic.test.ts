// §27.7 — Counter logic tests: day-anchor reset, count guards, floor guard.
//
// The existing counters.test.ts covers the "await vs void" regression (#392).
// This file covers the specific computation paths in each counter helper that
// Stryker marked as NoCoverage (73 survived + 22 NoCoverage in counters.ts):
//   - incrementEmailSent day-anchor: different day_ref → reset today count to 1
//   - incrementEmailSent same-day: accumulate existing count
//   - incrementGroupInvitees: count ≤ 0 is a no-op (no DB call)
//   - adjustRagChunkCount: Math.max(0, existing + delta) floor prevents negatives
//   - adjustRagChunkCount: first chunk (null row) → insert with Math.max(0, delta)
//   - incrementChatMessages: inserts new row when no existing metrics row

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── mocks ──────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  checkState: vi.fn(),
  safeAwait: vi.fn(),
}));

vi.mock("@/lib/abuse/state-machine", () => ({
  checkStateTransitionIfNeeded: mocks.checkState,
}));

vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: mocks.safeAwait,
}));

import {
  incrementChatMessages,
  incrementEmailSent,
  incrementGroupInvitees,
  adjustRagChunkCount,
} from "@/lib/abuse/counters";

// ── DB mock helpers ────────────────────────────────────────────────────────

// Returns a DB whose maybySingle() calls serve from `rowQueue` in order.
// update() and insert() calls are captured so tests can assert on payload.
function makeDb(rowQueue: Array<unknown>): {
  db: SupabaseClient;
  updates: unknown[];
  inserts: unknown[];
} {
  let i = 0;
  const updates: unknown[] = [];
  const inserts: unknown[] = [];

  const b: Record<string, (...args: unknown[]) => unknown> = {
    select: () => b,
    eq: () => b,
    order: () => b,
    limit: () => b,
    lte: () => b,
    update: (d: unknown) => { updates.push(d); return b; },
    insert: (d: unknown) => { inserts.push(d); return b; },
    maybeSingle: () => Promise.resolve({ data: rowQueue[i++] ?? null, error: null }),
  };

  return { db: { from: () => b } as unknown as SupabaseClient, updates, inserts };
}

const TENANT = {
  tenant_id: "t-1",
  tier_code: "sub_pro" as const,
  seat_count: 1,
  billing_period: "monthly" as const,
};

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkState.mockResolvedValue(undefined);
  mocks.safeAwait.mockResolvedValue(null);
});

// ── incrementEmailSent — day-anchor reset ─────────────────────────────────

describe("incrementEmailSent — day-anchor reset", () => {
  it("resets email_sent_today to 1 when day_ref differs from today", async () => {
    const existingRow = {
      id: "row-1",
      email_sent_today: 50,
      email_sent_day_ref: YESTERDAY,
      email_sent_count: 200,
    };
    // Post-write read (for checkStateTransitionIfNeeded): not reached here since
    // checkState is mocked — but the builder must still return something.
    const { db, updates } = makeDb([existingRow]);

    await incrementEmailSent({ db, tenant: TENANT });

    expect(mocks.safeAwait).toHaveBeenCalled();
    const update = updates[0] as { email_sent_today: number; email_sent_count: number };
    expect(update.email_sent_today).toBe(1);    // reset — not 51
    expect(update.email_sent_count).toBe(201);  // total always increments
  });

  it("accumulates email_sent_today when day_ref matches today", async () => {
    const existingRow = {
      id: "row-1",
      email_sent_today: 5,
      email_sent_day_ref: TODAY,
      email_sent_count: 50,
    };
    const { db, updates } = makeDb([existingRow]);

    await incrementEmailSent({ db, tenant: TENANT });

    const update = updates[0] as { email_sent_today: number; email_sent_count: number };
    expect(update.email_sent_today).toBe(6);   // accumulated — not 1
    expect(update.email_sent_count).toBe(51);
  });

  it("sets day_ref to today in both the reset and accumulate paths", async () => {
    const existingRow = {
      id: "row-1",
      email_sent_today: 3,
      email_sent_day_ref: YESTERDAY,
      email_sent_count: 10,
    };
    const { db, updates } = makeDb([existingRow]);

    await incrementEmailSent({ db, tenant: TENANT });

    const update = updates[0] as { email_sent_day_ref: string };
    expect(update.email_sent_day_ref).toBe(TODAY);
  });

  it("inserts a new row (count=1, today=1) when no metrics row exists for the period", async () => {
    const { db, inserts } = makeDb([null]); // no existing row

    await incrementEmailSent({ db, tenant: TENANT });

    // No state check fired — insert branch skips it (counter starts, no threshold check).
    expect(inserts).toHaveLength(1);
    const insert = inserts[0] as { email_sent_count: number; email_sent_today: number; billing_period: string };
    expect(insert.email_sent_count).toBe(1);
    expect(insert.email_sent_today).toBe(1);
    // billing_period is a postgres range string [YYYY-MM-01,YYYY-MM+1-01)
    const now2 = new Date();
    const yearMonth = now2.toISOString().slice(0, 7);
    const nextYearMonth2 = new Date(Date.UTC(now2.getUTCFullYear(), now2.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
    expect(insert.billing_period).toMatch(new RegExp(`^\\[${yearMonth}-01,${nextYearMonth2}-01\\)$`));
    // State machine not called on the first insert (no prior count to classify).
    expect(mocks.checkState).not.toHaveBeenCalled();
  });

  it("calls checkStateTransitionIfNeeded with email_volume dimension and newToday as metric", async () => {
    const existingRow = {
      id: "row-1",
      email_sent_today: 5,
      email_sent_day_ref: TODAY,
      email_sent_count: 50,
    };
    // Post-state-check read (for email_volume metric_value): returns row with email_sent_today=6.
    const { db } = makeDb([existingRow, { email_sent_today: 6 }]);

    await incrementEmailSent({ db, tenant: TENANT });

    expect(mocks.checkState).toHaveBeenCalledWith(
      expect.objectContaining({ dimension: "email_volume", metric_value: 6n }),
    );
  });
});

// ── incrementGroupInvitees — count guard ──────────────────────────────────

describe("incrementGroupInvitees — count ≤ 0 guard", () => {
  it("is a no-op when count = 0 (no DB call, no state check)", async () => {
    const { db } = makeDb([]);
    await incrementGroupInvitees({ db, tenant: TENANT }, 0);
    expect(mocks.checkState).not.toHaveBeenCalled();
    expect(mocks.safeAwait).not.toHaveBeenCalled();
  });

  it("is a no-op when count is negative", async () => {
    const { db } = makeDb([]);
    await incrementGroupInvitees({ db, tenant: TENANT }, -3);
    expect(mocks.checkState).not.toHaveBeenCalled();
    expect(mocks.safeAwait).not.toHaveBeenCalled();
  });

  it("proceeds normally when count = 1 (min positive value)", async () => {
    // upsertMetrics read + post-increment read.
    const { db } = makeDb([null, { group_invitees_count: 1 }]);
    await incrementGroupInvitees({ db, tenant: TENANT }, 1);
    expect(mocks.checkState).toHaveBeenCalledWith(
      expect.objectContaining({ dimension: "group_invite", metric_value: 1n }),
    );
  });
});

// ── adjustRagChunkCount — Math.max(0, …) floor ────────────────────────────

describe("adjustRagChunkCount — floor prevents negative chunk count", () => {
  it("writes 0 when delta would produce a negative count (existing=3, delta=-5)", async () => {
    const existingRow = { current_tenant_chunks_count: 3, base_cap: 100 };
    // Provide two rows: one for the initial read, one for the post-write read.
    const { db, updates } = makeDb([existingRow, { current_tenant_chunks_count: 0 }]);

    await adjustRagChunkCount({ db, tenant: TENANT }, -5, 0);

    const update = updates[0] as { current_tenant_chunks_count: number };
    expect(update.current_tenant_chunks_count).toBe(0); // Math.max(0, 3-5) = 0
  });

  it("writes exact count when delta is positive (no clamping needed)", async () => {
    const existingRow = { current_tenant_chunks_count: 10, base_cap: 100 };
    const { db, updates } = makeDb([existingRow, { current_tenant_chunks_count: 13 }]);

    await adjustRagChunkCount({ db, tenant: TENANT }, 3, 0);

    const update = updates[0] as { current_tenant_chunks_count: number };
    expect(update.current_tenant_chunks_count).toBe(13);
    expect(mocks.checkState).toHaveBeenCalledWith(
      expect.objectContaining({ dimension: "rag_cap", metric_value: 13 }),
    );
  });

  it("inserts with Math.max(0, delta) when no quota row exists (first chunk)", async () => {
    // null → insert; then the post-write read returns the new row.
    const { db, inserts } = makeDb([null, { current_tenant_chunks_count: 5 }]);

    await adjustRagChunkCount({ db, tenant: TENANT }, 5, 2);

    expect(inserts).toHaveLength(1);
    const insert = inserts[0] as { current_tenant_chunks_count: number; promoted_chunks_count: number };
    expect(insert.current_tenant_chunks_count).toBe(5); // Math.max(0, 5)
    expect(insert.promoted_chunks_count).toBe(2);
  });

  it("inserts 0 when delta is negative on first chunk (Math.max floor)", async () => {
    const { db, inserts } = makeDb([null, { current_tenant_chunks_count: 0 }]);

    await adjustRagChunkCount({ db, tenant: TENANT }, -10, 0);

    const insert = inserts[0] as { current_tenant_chunks_count: number };
    expect(insert.current_tenant_chunks_count).toBe(0); // Math.max(0, -10) = 0
  });
});

// ── incrementChatMessages — upsert paths ──────────────────────────────────

describe("incrementChatMessages — existing vs. new row", () => {
  it("inserts new row when no metrics row exists for the period", async () => {
    // upsertMetrics read → null; post-increment read for state check.
    const { db, inserts } = makeDb([null, { chat_messages_count: 1 }]);

    await incrementChatMessages({ db, tenant: TENANT });

    expect(inserts).toHaveLength(1);
    const insert = inserts[0] as { chat_messages_count: number };
    expect(insert.chat_messages_count).toBe(1);
    expect(mocks.checkState).toHaveBeenCalledOnce();
  });

  it("updates existing row by adding 1 to current count", async () => {
    const existingRow = { id: "m1", chat_messages_count: 42, email_sent_count: 0, email_sent_today: 0, email_sent_day_ref: TODAY, group_invitees_count: 0 };
    // upsertMetrics read → existing; post-increment read.
    const { db, updates } = makeDb([existingRow, { chat_messages_count: 43 }]);

    await incrementChatMessages({ db, tenant: TENANT });

    const update = updates[0] as { chat_messages_count: number };
    expect(update.chat_messages_count).toBe(43); // 42 + 1
    expect(mocks.checkState).toHaveBeenCalledWith(
      expect.objectContaining({ dimension: "chat_volume", metric_value: 43n }),
    );
  });

  it("insert billing_period covers current month in postgres range format [start,end)", async () => {
    const { db, inserts } = makeDb([null, { chat_messages_count: 1 }]);

    await incrementChatMessages({ db, tenant: TENANT });

    const insert = inserts[0] as { billing_period: string; tenant_id: string };
    const now = new Date();
    const yearMonth = now.toISOString().slice(0, 7);
    const nextMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const nextYearMonth = nextMonthDate.toISOString().slice(0, 7);
    // Range must start on current month's 1st AND end on next month's 1st.
    expect(insert.billing_period).toMatch(new RegExp(`^\\[${yearMonth}-01,${nextYearMonth}-01\\)$`));
    expect(insert.tenant_id).toBe("t-1");
  });
});
