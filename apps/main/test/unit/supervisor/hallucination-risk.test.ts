// §21.10 Layer 3 — hallucination_risk grounding tests.
//
// The Haiku claim-extraction call is gated by ANTHROPIC_API_KEY; the tests
// here run WITHOUT that key, so the check returns 'skipped' info severity.
// What we DO verify is the grounding heuristic indirectly via the no-chunks
// branch and the env-gated skip path. Real claim-grounding coverage requires
// an integration test with a recorded Haiku response — left as follow-up
// per BP21 measurement-points scope.

import { describe, it, expect, beforeEach } from "vitest";
import { checkHallucinationRisk } from "@/lib/supervisor/checks/hallucination-risk";

describe("checkHallucinationRisk — §21.10 Layer 3", () => {
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

  it("returns info when ANTHROPIC_API_KEY is unset", async () => {
    const out = await checkHallucinationRisk({
      candidate_response: "The buffet costs $40.",
      retrieved_chunks: [{ content: "The buffet costs $40." }],
    });
    expect(out.severity).toBe("info");
    expect(out.details).toMatch(/skipped/);
  });
});
