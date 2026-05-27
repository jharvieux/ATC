import { describe, it, expect } from "vitest";
import {
  loadConversationHistory,
  trimToBudget,
  type ChatTurn,
} from "@/lib/chat/conversation-history";

type Row = { role: string; content: string | null };

function makeDb(rows: Row[] | null, err: { message: string } | null = null) {
  return {
    from(_table: string) {
      void _table;
      return {
        select(_cols: string) {
          void _cols;
          return {
            eq(_col: string, _val: string) {
              void _col;
              void _val;
              return {
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
            },
          };
        },
      };
    },
  };
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
    const out = await loadConversationHistory(db, "conv-1");
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
    const out = await loadConversationHistory(db, "conv-1");
    expect(out.map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  it("skips rows with null/empty content", async () => {
    const db = makeDb([
      { role: "user", content: "first" },
      { role: "assistant", content: null },
      { role: "user", content: "" },
      { role: "user", content: "third" },
    ]);
    const out = await loadConversationHistory(db, "conv-1");
    expect(out).toEqual([
      { role: "user", content: "first" },
      { role: "user", content: "third" },
    ]);
  });

  it("returns empty for new conversation", async () => {
    const db = makeDb([]);
    const out = await loadConversationHistory(db, "conv-new");
    expect(out).toEqual([]);
  });

  it("throws on db error so caller can surface it", async () => {
    const db = makeDb(null, { message: "permission denied" });
    await expect(loadConversationHistory(db, "conv-x")).rejects.toThrow(/permission denied/);
  });

  it("applies maxChars budget", async () => {
    const db = makeDb([
      { role: "user", content: "a".repeat(100) },
      { role: "assistant", content: "b".repeat(100) },
      { role: "user", content: "current" },
    ]);
    const out = await loadConversationHistory(db, "conv-1", { maxChars: 20 });
    expect(out[out.length - 1]!.content).toBe("current");
    expect(out[0]!.role).toBe("user");
  });
});
