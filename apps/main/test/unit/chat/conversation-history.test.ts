import { describe, it, expect } from "vitest";
import {
  loadConversationHistory,
  trimToBudget,
  type ChatTurn,
} from "@/lib/chat/conversation-history";

type Row = { role: string; content: string | null };

function makeDb(rows: Row[] | null, err: { message: string } | null = null) {
  // Records every .eq() call so tests can assert the tenant_id filter
  // is wired into the actual query (D-091 two-layer-isolation doctrine).
  // Also records the .order()/.limit() args so #1587 tests can assert the
  // query is bounded and ordered newest-first (not just trimmed in JS).
  const eqCalls: Array<{ col: string; val: string }> = [];
  const orderCalls: Array<{ col: string; ascending: boolean }> = [];
  const limitCalls: number[] = [];
  const client = {
    eqCalls,
    orderCalls,
    limitCalls,
    from(_table: string) {
      void _table;
      return {
        select(_cols: string) {
          void _cols;
          const chain = {
            eq(col: string, val: string) {
              eqCalls.push({ col, val });
              return chain;
            },
            in(_inCol: string, _vals: readonly string[]) {
              void _inCol;
              void _vals;
              return {
                order: (orderCol: string, opts: { ascending: boolean }) => {
                  orderCalls.push({ col: orderCol, ascending: opts.ascending });
                  return {
                    limit: async (n: number) => {
                      limitCalls.push(n);
                      // Fixtures are written chronologically (oldest first)
                      // for readability. Simulate what a real
                      // `.order(desc).limit(n)` query returns: the newest
                      // n rows, in descending (newest-first) order — which
                      // is what loadConversationHistory then reverses back.
                      if (rows === null) return { data: null, error: err };
                      const newestChronological = rows.slice(Math.max(0, rows.length - n));
                      const descending = newestChronological.slice().reverse();
                      return { data: descending, error: err };
                    },
                  };
                },
              };
            },
          };
          return chain;
        },
      };
    },
  };
  return client;
}

describe("trimToBudget", () => {
  it("returns input unchanged when under budget", () => {
    const turns: ChatTurn[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "how are you" },
    ];
    expect(trimToBudget(turns, 1000)).toEqual(turns);
  });

  it("drops oldest turns until under budget", () => {
    const turns: ChatTurn[] = [
      { role: "user", content: "a".repeat(100) },
      { role: "assistant", content: "b".repeat(100) },
      { role: "user", content: "c".repeat(100) },
      { role: "assistant", content: "d".repeat(100) },
      { role: "user", content: "e".repeat(100) },
    ];
    const out = trimToBudget(turns, 250);
    expect(out.length).toBeLessThan(turns.length);
    expect(out[out.length - 1]!.content).toBe("e".repeat(100));
    const total = out.reduce((s, t) => s + t.content.length, 0);
    expect(total).toBeLessThanOrEqual(250);
  });

  it("drops leading assistant after trim (Anthropic requires user-first)", () => {
    const turns: ChatTurn[] = [
      { role: "user", content: "old".repeat(50) },
      { role: "assistant", content: "old reply".repeat(50) },
      { role: "user", content: "recent" },
      { role: "assistant", content: "recent reply" },
      { role: "user", content: "current" },
    ];
    const out = trimToBudget(turns, 30);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.role).toBe("user");
  });

  it("returns empty array when budget excludes everything", () => {
    const turns: ChatTurn[] = [
      { role: "user", content: "a".repeat(100) },
      { role: "assistant", content: "b".repeat(100) },
    ];
    expect(trimToBudget(turns, 0)).toEqual([]);
  });

  it("preserves order within retained turns", () => {
    const turns: ChatTurn[] = [
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
      { role: "assistant", content: "4" },
      { role: "user", content: "5" },
    ];
    const out = trimToBudget(turns, 1000);
    expect(out.map((t) => t.content)).toEqual(["1", "2", "3", "4", "5"]);
  });
});

describe("loadConversationHistory", () => {
  it("returns ordered turns from db", async () => {
    const db = makeDb([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply1" },
      { role: "user", content: "second" },
    ]);
    const out = await loadConversationHistory(db, "t-1", "conv-1");
    expect(out).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply1" },
      { role: "user", content: "second" },
    ]);
  });

  it("filters out system/escalation rows", async () => {
    const db = makeDb([
      { role: "user", content: "first" },
      { role: "system", content: "ignored" },
      { role: "assistant", content: "reply" },
    ]);
    const out = await loadConversationHistory(db, "t-1", "conv-1");
    expect(out.map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  it("skips rows with null/empty content (and alternation-guard collapses the resulting consecutive users)", async () => {
    const db = makeDb([
      { role: "user", content: "first" },
      { role: "assistant", content: null },
      { role: "user", content: "" },
      { role: "user", content: "third" },
    ]);
    const out = await loadConversationHistory(db, "t-1", "conv-1");
    // After null/empty filter we have ["first", "third"] (two user rows
    // because the assistant row was dropped). The alternation guard
    // then collapses to the latest in the consecutive-user run.
    expect(out).toEqual([{ role: "user", content: "third" }]);
  });

  it("returns empty for new conversation", async () => {
    const db = makeDb([]);
    const out = await loadConversationHistory(db, "t-1", "conv-new");
    expect(out).toEqual([]);
  });

  it("throws on db error so caller can surface it", async () => {
    const db = makeDb(null, { message: "permission denied" });
    await expect(loadConversationHistory(db, "t-1", "conv-x")).rejects.toThrow(/permission denied/);
  });

  it("applies maxChars budget", async () => {
    const db = makeDb([
      { role: "user", content: "a".repeat(100) },
      { role: "assistant", content: "b".repeat(100) },
      { role: "user", content: "current" },
    ]);
    const out = await loadConversationHistory(db, "t-1", "conv-1", { maxChars: 20 });
    expect(out[out.length - 1]!.content).toBe("current");
    expect(out[0]!.role).toBe("user");
  });

  // Greptile #266 P1 — db-layer tenant scoping (two-layer doctrine).
  it("passes both tenant_id AND conversation_id as .eq filters", async () => {
    const db = makeDb([{ role: "user", content: "x" }]);
    await loadConversationHistory(db, "t-7", "conv-99");
    expect(db.eqCalls).toEqual(
      expect.arrayContaining([
        { col: "tenant_id", val: "t-7" },
        { col: "conversation_id", val: "conv-99" },
      ]),
    );
  });

  // #1587 — the query must carry an explicit bound and order newest-first
  // at the DB layer, not just trim in JS after an unbounded fetch.
  it("orders newest-first and caps rows with an explicit .limit()", async () => {
    const db = makeDb([{ role: "user", content: "x" }]);
    await loadConversationHistory(db, "t-1", "conv-1");
    expect(db.orderCalls).toEqual([{ col: "created_at", ascending: false }]);
    expect(db.limitCalls).toEqual([60]);
  });

  // #1587 — with ascending order and no limit, a thread longer than the
  // server's max-rows got silently truncated from the front, dropping the
  // newest messages (the ones that matter most). Asserts the fetched rows
  // are still returned in chronological order with the newest message
  // last, i.e. the row cap keeps the newest turns, not the oldest.
  it("keeps the newest messages when the thread exceeds the row limit", async () => {
    const longThread: Row[] = [];
    for (let i = 0; i < 80; i++) {
      longThread.push({ role: i % 2 === 0 ? "user" : "assistant", content: `turn-${i}` });
    }
    const db = makeDb(longThread);
    const out = await loadConversationHistory(db, "t-1", "conv-1", { maxChars: 1_000_000 });
    // Only the newest 60 of 80 turns survive the row cap.
    expect(out.length).toBe(60);
    // Newest turn (turn-79) must be present and last — not dropped in
    // favor of earlier turns, which is what the old ascending+no-limit
    // query would have done once truncated server-side.
    expect(out[out.length - 1]!.content).toBe("turn-79");
    expect(out[0]!.content).toBe("turn-20");
    // Still in chronological order.
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.content > out[i - 1]!.content).toBe(true);
    }
  });
});

describe("trimToBudget — alternation guard (Greptile #266)", () => {
  it("collapses consecutive user turns to the latest", () => {
    const turns: ChatTurn[] = [
      { role: "user", content: "u1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a1" },
    ];
    expect(trimToBudget(turns, 1000)).toEqual([
      { role: "user", content: "u2" },
      { role: "assistant", content: "a1" },
    ]);
  });

  it("collapses consecutive assistant turns to the latest", () => {
    const turns: ChatTurn[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u2" },
    ];
    expect(trimToBudget(turns, 1000)).toEqual([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u2" },
    ]);
  });

  it("returns alternating order even when input has multiple runs", () => {
    const turns: ChatTurn[] = [
      { role: "user", content: "u1" },
      { role: "user", content: "u2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u4" },
    ];
    const out = trimToBudget(turns, 1000);
    // Verify strict alternation.
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.role).not.toBe(out[i - 1]!.role);
    }
    // Verify latest-in-run preservation.
    expect(out.map((t) => t.content)).toEqual(["u3", "a2", "u4"]);
  });
});
