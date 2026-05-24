// BP24 §10 — Sentence-boundary buffering tests.
//
// The behaviour under test is *contract*, not implementation:
//   - A sentence terminator + whitespace flushes (this is the latency win;
//     a regression here would defeat the streaming supervisor handoff).
//   - Abbreviations (Mr., e.g., U.S.) do NOT flush prematurely (a regression
//     here causes the supervisor to scan fragments and false-positive).
//   - Decimal points in numbers do NOT flush ($3.50 → no flush at the dot).
//   - Stream end always flushes trailing partial sentence (so the user
//     never loses the last unterminated clause).
//   - Hard cap bounds memory on a runaway un-terminated response.

import { describe, expect, it } from "vitest";
import { bufferToSentences, findNextBoundary } from "../../../src/lib/ai/sentence-buffer";

async function collect(input: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const s of input) out.push(s);
  return out;
}

async function* fromChunks(chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) yield c;
}

describe("findNextBoundary", () => {
  it("returns -1 when no terminator is present", () => {
    expect(findNextBoundary("hello world")).toBe(-1);
  });

  it("returns the index after a terminator followed by whitespace", () => {
    const s = "Hello. World";
    // 'Hello.' is positions 0..5; the period is at index 5, whitespace at 6.
    // The boundary index returned is AFTER the period, i.e. 6.
    expect(findNextBoundary(s)).toBe(6);
  });

  it("does not flush at an abbreviation", () => {
    expect(findNextBoundary("Speak with Mr. Smith")).toBe(-1);
  });

  it("does not flush at a decimal point", () => {
    expect(findNextBoundary("Costs $3.50 today")).toBe(-1);
  });

  it("does not flush mid-token (URL example)", () => {
    expect(findNextBoundary("Go to example.com/path")).toBe(-1);
  });

  it("flushes after ? and !", () => {
    expect(findNextBoundary("Really? Yes")).toBe(7);
    expect(findNextBoundary("Wow! Sure")).toBe(4);
  });
});

describe("bufferToSentences", () => {
  it("emits a single sentence when the stream is one full sentence with no whitespace tail", async () => {
    const out = await collect(bufferToSentences(fromChunks(["Hello world."])));
    // The buffer can't tell mid-stream that the period is followed by EOS,
    // so it defers to the end-flush path. Either way the caller gets it.
    expect(out).toEqual(["Hello world."]);
  });

  it("emits two sentences when separated by a space inside one chunk", async () => {
    const out = await collect(bufferToSentences(fromChunks(["First. Second."])));
    expect(out).toEqual(["First.", "Second."]);
  });

  it("emits sentences across chunk boundaries that split mid-terminator", async () => {
    // Period arrives in chunk A, space arrives in chunk B — the second chunk
    // is when the boundary becomes detectable.
    const out = await collect(bufferToSentences(fromChunks(["First", ".", " Second."])));
    expect(out).toEqual(["First.", "Second."]);
  });

  it("does NOT flush at an abbreviation followed by a space mid-sentence", async () => {
    const out = await collect(bufferToSentences(fromChunks(["Speak with Mr. Smith now. Continue."])));
    expect(out).toEqual(["Speak with Mr. Smith now.", "Continue."]);
  });

  it("does NOT flush inside a decimal number", async () => {
    const out = await collect(bufferToSentences(fromChunks(["The cost is $3.50 today. End."])));
    expect(out).toEqual(["The cost is $3.50 today.", "End."]);
  });

  it("flushes the trailing partial sentence on stream end", async () => {
    const out = await collect(bufferToSentences(fromChunks(["First. Second without terminator"])));
    expect(out).toEqual(["First.", "Second without terminator"]);
  });

  it("respects the hard cap by emitting a chunk when no boundary appears", async () => {
    const giant = "a".repeat(900);
    const out = await collect(bufferToSentences(fromChunks([giant]), { maxBufferChars: 800 }));
    // Hard cap = 800 → first emission is the buffer when it exceeds 800.
    // Trailing flush handles whatever's left after.
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.join("")).toBe(giant);
  });

  it("handles ? and ! terminators correctly", async () => {
    const out = await collect(bufferToSentences(fromChunks(["What? Yes! Done."])));
    expect(out).toEqual(["What?", "Yes!", "Done."]);
  });

  it("handles many small token-sized chunks (single-character emit)", async () => {
    const text = "Hi there. How are you? Fine.";
    const chunks = text.split("");
    const out = await collect(bufferToSentences(fromChunks(chunks)));
    expect(out).toEqual(["Hi there.", "How are you?", "Fine."]);
  });

  it("does not emit empty sentences from leading whitespace", async () => {
    const out = await collect(bufferToSentences(fromChunks(["   First. Second."])));
    expect(out).toEqual(["First.", "Second."]);
  });
});
