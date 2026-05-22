// §10.2 / §21.10 — persona_drift v1 tests.

import { describe, it, expect } from "vitest";
import { checkPersonaDrift } from "@/lib/supervisor/checks/persona-drift";

describe("checkPersonaDrift v1", () => {
  it("flags model self-references", () => {
    const out = checkPersonaDrift({
      candidate_response: "As an AI language model, I cannot recommend a specific cruise.",
    });
    expect(out.severity).toBe("warning");
    expect(out.details).toMatch(/model-self-reference/);
  });

  it("flags Anthropic/OpenAI self-mentions", () => {
    const out = checkPersonaDrift({
      candidate_response: "I was trained by Anthropic to help with travel.",
    });
    expect(out.severity).toBe("warning");
  });

  it("flags persona refusals", () => {
    const out = checkPersonaDrift({
      candidate_response: "I cannot pretend to be a real travel agent.",
    });
    expect(out.severity).toBe("warning");
  });

  it("flags unknown self-introduction names", () => {
    const out = checkPersonaDrift({
      candidate_response: "Hello, I'm Sarah from the agency!",
    });
    expect(out.severity).toBe("warning");
    expect(out.details).toMatch(/unknown persona/);
  });

  it("passes known persona name introductions", () => {
    const out = checkPersonaDrift({
      candidate_response: "Hello! I'm Marcus, happy to help.",
    });
    expect(out.severity).toBe("info");
  });

  it("passes clean persona prose", () => {
    const out = checkPersonaDrift({
      candidate_response: "Caribbean cruises are wonderful in winter.",
    });
    expect(out.severity).toBe("info");
  });
});
