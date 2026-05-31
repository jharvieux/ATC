// §21.10 Layer 3 — hallucination_risk grounding tests.
//
// The check works in two stages: a Haiku call extracts concrete factual
// claims from the candidate reply, then each claim is grounded locally by
// keyword overlap against the retrieved chunks (≥50% of a claim's content
// tokens must appear in some chunk). Severity is `warning` iff ≥1 claim is
// ungrounded, else `info`.
//
// The grounding describe-block mocks instrumentedClaudeCall to return
// scripted claim-extraction JSON, then drives the grounding outcome via the
// chunk content — so the core rule (warning on an unsupported claim) is
// pinned. Deliberately forcing checkHallucinationRisk to always return
// `info` makes the "ungrounded claim" test fail, which is the point.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callReturnText: "" as string,
}));

vi.mock("@/lib/ai/call-wrapper", () => ({
  instrumentedClaudeCall: async () => ({ text: mocks.callReturnText, raw: {} }),
}));

import { checkHallucinationRisk } from "@/lib/supervisor/checks/hallucination-risk";

const ORIG_KEY = process.env.ANTHROPIC_API_KEY;

// Per-test isolation comes from resetting mocks.callReturnText / the env key
// in each beforeEach; the module mock is installed once and never restored.
afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIG_KEY;
});

describe("checkHallucinationRisk — bypass branches", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("returns info when no chunks retrieved (no-result instructions own this)", async () => {
    const out = await checkHallucinationRisk({
      candidate_response: "We have great cabins.",
      retrieved_chunks: [],
    });
    expect(out.severity).toBe("info");
    expect(out.details).toMatch(/no chunks/);
  });

  it("returns info when ANTHROPIC_API_KEY is unset (claim extraction can't run)", async () => {
    const out = await checkHallucinationRisk({
      candidate_response: "The buffet costs $40.",
      retrieved_chunks: [{ content: "The buffet costs $40." }],
    });
    expect(out.severity).toBe("info");
    expect(out.details).toMatch(/skipped/);
  });
});

describe("checkHallucinationRisk — grounding rule", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-test-fake";
    mocks.callReturnText = "";
  });

  it("info when the extracted claim IS grounded by a chunk", async () => {
    // Haiku extracts one concrete claim; the chunk repeats its key tokens
    // (buffet/open/until/11pm) so overlap is 100% → grounded.
    mocks.callReturnText = JSON.stringify({
      claims: [{ text: "the buffet is open until 11pm", claim_type: "amenity" }],
    });
    const out = await checkHallucinationRisk({
      candidate_response: "Good news — the buffet is open until 11pm.",
      retrieved_chunks: [
        { content: "The buffet on deck 15 is open until 11pm nightly." },
      ],
    });
    expect(out.severity).toBe("info");
    expect(out.details).toMatch(/grounded/);
  });

  it("warning when an extracted claim is NOT supported by any chunk", async () => {
    // The claim's tokens (pool/deck/waterslide) appear in no chunk → 0%
    // overlap → flagged. This is the rule the supervisor exists to enforce.
    mocks.callReturnText = JSON.stringify({
      claims: [{ text: "the pool deck has a waterslide", claim_type: "amenity" }],
    });
    const out = await checkHallucinationRisk({
      candidate_response: "Yes — the pool deck has a waterslide.",
      retrieved_chunks: [
        { content: "Dining options include the main dining room and specialty restaurants." },
      ],
    });
    expect(out.severity).toBe("warning");
    expect(out.details).toContain("the pool deck has a waterslide");
  });

  it("info when Haiku finds no concrete claims to verify", async () => {
    mocks.callReturnText = JSON.stringify({ claims: [] });
    const out = await checkHallucinationRisk({
      candidate_response: "Cruises are a wonderful way to travel!",
      retrieved_chunks: [{ content: "Anything." }],
    });
    expect(out.severity).toBe("info");
    expect(out.details).toMatch(/no concrete claims/);
  });

  it("info (fail-open to no-flag) when Haiku returns unparseable output", async () => {
    // Malformed JSON must not crash the supervisor; the parser fallback
    // skips the check rather than throwing mid-turn.
    mocks.callReturnText = "not json at all {{{";
    const out = await checkHallucinationRisk({
      candidate_response: "The suite includes a private balcony.",
      retrieved_chunks: [{ content: "Some chunk content." }],
    });
    expect(out.check).toBe("hallucination_risk");
    expect(out.severity).toBe("info");
    expect(out.details).toMatch(/claim extraction failed/);
  });
});
