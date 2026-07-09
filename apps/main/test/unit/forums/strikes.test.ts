// §19.9 — Strike pattern enforcement tests.
//
// Uses a mock Supabase client to isolate DB logic.
// Why these tests matter: auto-mute firing too early (< 3 strikes) is
// a false-positive that silences legitimate users. Firing too late means
// the strike gate is bypassed.

import { describe, it, expect, vi } from "vitest";
import { checkStrikePatterns } from "@/lib/forums/strikes";
import type { SupabaseClient } from "@supabase/supabase-js";

type FromReturn = {
  select: () => FromReturn;
  eq: (...args: unknown[]) => FromReturn;
  gte: (...args: unknown[]) => FromReturn & Promise<{ data: unknown[] | null }>;
  then: Promise<{ data: unknown[] | null }>["then"];
};

function buildMockDb(rows: {
  aiHiddenRecent: number;
  coordinatorHiddenCumulative: number;
  totalCumulative: number;
}): SupabaseClient {
  const upsertMock = vi.fn().mockResolvedValue({ error: null });

  let callCount = 0;

  // Each call to .from("forum_strikes").select()... returns different counts
  const makeChain = (data: unknown[]): unknown => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      gte: () => Promise.resolve({ data }),
      then: (resolve: (v: { data: unknown[] }) => unknown) => Promise.resolve({ data }).then(resolve),
    };
    return chain;
  };

  const fromMock = vi.fn().mockImplementation((table: string) => {
    if (table === "forum_user_state") {
      return { upsert: upsertMock };
    }
    // forum_strikes: called 3 times — ai_hidden recent, coordinator_hidden cumulative, all cumulative
    callCount++;
    if (callCount === 1) return makeChain(Array(rows.aiHiddenRecent).fill({}));
    if (callCount === 2) return makeChain(Array(rows.coordinatorHiddenCumulative).fill({}));
    return makeChain(Array(rows.totalCumulative).fill({}));
  });

  return { from: fromMock } as unknown as SupabaseClient;
}

const ctx = { author: { user_id: "u1" }, forum_id: "f1", tenant_id: "t1" };

describe("checkStrikePatterns — §19.9", () => {
  it("2 ai_hidden strikes in 24h → no action", async () => {
    const db = buildMockDb({ aiHiddenRecent: 2, coordinatorHiddenCumulative: 0, totalCumulative: 2 });
    const result = await checkStrikePatterns(db, ctx);
    expect(result.auto_muted).toBe(false);
    expect(result.coordinator_review_prompt).toBe(false);
    expect(result.recommend_removal).toBe(false);
  });

  it("3 ai_hidden strikes in 24h → auto-mute", async () => {
    const db = buildMockDb({ aiHiddenRecent: 3, coordinatorHiddenCumulative: 0, totalCumulative: 3 });
    const result = await checkStrikePatterns(db, ctx);
    expect(result.auto_muted).toBe(true);
  });

  it("4 ai_hidden strikes in 24h → auto-mute (threshold is ≥3)", async () => {
    const db = buildMockDb({ aiHiddenRecent: 4, coordinatorHiddenCumulative: 0, totalCumulative: 4 });
    const result = await checkStrikePatterns(db, ctx);
    expect(result.auto_muted).toBe(true);
  });

  it("4 coordinator_hidden cumulative → no coordinator review prompt (threshold is 5)", async () => {
    const db = buildMockDb({ aiHiddenRecent: 0, coordinatorHiddenCumulative: 4, totalCumulative: 4 });
    const result = await checkStrikePatterns(db, ctx);
    expect(result.coordinator_review_prompt).toBe(false);
  });

  it("5 coordinator_hidden cumulative → coordinator review prompt", async () => {
    const db = buildMockDb({ aiHiddenRecent: 0, coordinatorHiddenCumulative: 5, totalCumulative: 5 });
    const result = await checkStrikePatterns(db, ctx);
    expect(result.coordinator_review_prompt).toBe(true);
    expect(result.recommend_removal).toBe(false);
  });

  it("9 total strikes → no recommend-removal (threshold is 10)", async () => {
    const db = buildMockDb({ aiHiddenRecent: 0, coordinatorHiddenCumulative: 5, totalCumulative: 9 });
    const result = await checkStrikePatterns(db, ctx);
    expect(result.recommend_removal).toBe(false);
  });

  it("10 total strikes → recommend removal", async () => {
    const db = buildMockDb({ aiHiddenRecent: 0, coordinatorHiddenCumulative: 5, totalCumulative: 10 });
    const result = await checkStrikePatterns(db, ctx);
    expect(result.recommend_removal).toBe(true);
  });
});

// #1572 — guest (invitation-authored) parity: the same pattern logic must
// fire off invitation_id, not just user_id, and the auto-mute upsert must
// write invitation_id (not a null-cast user_id) so a guest actually gets
// muted rather than silently no-op-ing.
describe("checkStrikePatterns — guest (invitation_id) authors — #1572", () => {
  it("3 ai_hidden strikes in 24h for a guest → auto-mute, upserts by invitation_id", async () => {
    const upsertMock = vi.fn().mockResolvedValue({ error: null });
    const fromMock = vi.fn().mockImplementation((table: string) => {
      if (table === "forum_user_state") return { upsert: upsertMock };
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.gte = () => Promise.resolve({ data: Array(3).fill({}) });
      return chain;
    });
    const db = { from: fromMock } as unknown as SupabaseClient;

    const result = await checkStrikePatterns(db, { author: { invitation_id: "inv-1" }, forum_id: "f1", tenant_id: "t1" });

    expect(result.auto_muted).toBe(true);
    // The onConflict arbiter must target "forum_id,invitation_id" and — since
    // PostgREST emits no predicate on ON CONFLICT — that target must resolve to
    // a FULL (non-partial) unique constraint, else Postgres raises 42P10 and the
    // guest is never muted. Migration
    // 20260709111701_forum_user_state_invitation_full_unique.sql replaces the
    // original partial index with constraint forum_user_state_forum_invitation_key
    // to satisfy exactly this. NOTE: this mock cannot prove arbiter semantics —
    // it only asserts the target string. Real 42P10-vs-no-error behaviour is
    // proven by the live test-DB smoke test recorded in PR #1709's Verification
    // section (guest upsert twice → no 42P10, exactly one row).
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ invitation_id: "inv-1", forum_id: "f1", is_muted: true }),
      expect.objectContaining({ onConflict: "forum_id,invitation_id" }),
    );
  });
});
