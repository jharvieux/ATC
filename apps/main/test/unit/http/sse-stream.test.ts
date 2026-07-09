import { describe, it, expect } from "vitest";
import { splitSseLines } from "@/lib/http/sse-stream";

describe("splitSseLines", () => {
  it("splits a single chunk containing complete lines", () => {
    const { lines, remainder } = splitSseLines("", "data: hello\n\n");
    expect(lines).toEqual(["data: hello", ""]);
    expect(remainder).toBe("");
  });

  it("carries a trailing partial line into the remainder", () => {
    const { lines, remainder } = splitSseLines("", "data: hel");
    expect(lines).toEqual([]);
    expect(remainder).toBe("data: hel");
  });

  // #1593 — the actual bug: a `data: ` line split across two network
  // chunks. Parsing each chunk independently means neither half starts
  // with "data: ", so the line is silently dropped. The buffer must
  // reassemble it into one intact line on the next call.
  it("reassembles a data: line split across two chunks", () => {
    const first = splitSseLines("", "data: hel");
    expect(first.lines).toEqual([]);
    const second = splitSseLines(first.remainder, "lo world\n\n");
    expect(second.lines).toEqual(["data: hello world", ""]);
  });

  // Sentinels ([DONE]/[REWRITE]) are matched by exact string equality
  // after stripping "data: " — if the split lands mid-sentinel, a naive
  // per-chunk parse would miss it entirely.
  it("reassembles a [REWRITE] sentinel split across chunks", () => {
    const first = splitSseLines("", "data: [REW");
    const second = splitSseLines(first.remainder, "RITE]\n\n");
    expect(second.lines).toEqual(["data: [REWRITE]", ""]);
  });

  it("reassembles a [DONE] sentinel split across chunks", () => {
    const first = splitSseLines("", "data: [DO");
    const second = splitSseLines(first.remainder, "NE]\n\n");
    expect(second.lines).toEqual(["data: [DONE]", ""]);
  });

  it("handles multiple complete lines in one chunk plus a trailing partial", () => {
    const { lines, remainder } = splitSseLines(
      "",
      "data: one\n\ndata: two\n\ndata: thr",
    );
    expect(lines).toEqual(["data: one", "", "data: two", ""]);
    expect(remainder).toBe("data: thr");
  });

  it("accumulates across many small chunks (byte-at-a-time worst case)", () => {
    const full = "data: abc\n\n";
    let buf = "";
    const collected: string[] = [];
    for (const ch of full) {
      const { lines, remainder } = splitSseLines(buf, ch);
      buf = remainder;
      collected.push(...lines);
    }
    expect(collected).toEqual(["data: abc", ""]);
  });
});
