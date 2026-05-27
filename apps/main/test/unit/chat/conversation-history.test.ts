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
  const eqCalls: Array<{ col: string; val: string }> = [];
  const client = {
    eqCalls,
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
                order: async (_orderCol: string, _opts: { ascending: boolean }) => {
                  void _orderCol;
                  void _opts;
                  return { data: rows, error: err };
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
