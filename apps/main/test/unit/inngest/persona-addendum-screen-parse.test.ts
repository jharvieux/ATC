// §27.12 — parseScreenResult from the persona-addendum-screen consumer.
// Fail-closed semantics: unparseable / missing-pass / control-character
// shenanigans all become rejections.

import { describe, it, expect } from "vitest";
import { parseScreenResult } from "@/inngest/persona-addendum-screen";

describe("parseScreenResult", () => {
  it("parses a clean pass response", () => {
    const r = parseScreenResult('{"pass": true, "findings": []}');
    expect(r.pass).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it("parses a fail response with findings", () => {
    const r = parseScreenResult(
      '{"pass": false, "findings": [{"category": "prompt_injection", "evidence": "ignore previous"}]}',
    );
    expect(r.pass).toBe(false);
    if (!r.pass) {
      expect(r.findings).toHaveLength(1);
      expect(r.findings[0]?.category).toBe("prompt_injection");
    }
  });

  it("fail-closes on unparseable text", () => {
    const r = parseScreenResult("the model gave a prose answer");
    expect(r.pass).toBe(false);
    if (!r.pass) {
      expect(r.findings[0]?.category).toBe("parse_error");
    }
  });

  it("fail-closes when JSON has no 'pass' field", () => {
    const r = parseScreenResult('{"verdict": "approved"}');
    expect(r.pass).toBe(false);
  });

  it("tolerates JSON embedded in prose (extracts outermost braces)", () => {
    const r = parseScreenResult(
      'Here is the verdict:\n\n{"pass": true, "findings": []}\n\nThanks.',
    );
    expect(r.pass).toBe(true);
  });

  it("fail-closes when JSON.parse throws on malformed payload", () => {
    const r = parseScreenResult('{"pass": true, "findings": [bad]}');
    expect(r.pass).toBe(false);
    if (!r.pass) {
      expect(r.findings[0]?.category).toBe("parse_error");
    }
  });
});
