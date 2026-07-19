// #2009 — strict JSON parser for batched precruise results.
//
// The batched request is schema-constrained via output_config.format
// (json_schema), so a successful result is guaranteed to be a bare JSON
// object. The parser therefore REJECTS anything else — fences, prose
// wrappers, truncated objects — instead of the old fence-strip +
// outermost-brace slicing. WHY strict matters: brace-slicing could
// silently accept a max_tokens-truncated or refusal response whose
// sliced substring happens to parse, sending a broken email. A rejected
// row stays unsent and the daily scheduler re-fires it.

import { describe, it, expect } from "vitest";
import { parseStructuredJson } from "@/inngest/precruise-generate-and-send";

describe("parseStructuredJson (strict — provider-constrained output)", () => {
  it("parses a bare JSON object", () => {
    const r = parseStructuredJson(`{"foo": "bar", "n": 3}`);
    expect(r).toEqual({ foo: "bar", n: 3 });
  });

  it("parses nested objects and arrays", () => {
    const r = parseStructuredJson(`{"a": 1, "b": {"c": 2}, "d": ["x"]}`);
    expect(r).toEqual({ a: 1, b: { c: 2 }, d: ["x"] });
  });

  it("rejects fenced output — constrained decoding never fences, so a fence means the constraint was not applied", () => {
    expect(parseStructuredJson("```json\n{\"foo\": \"bar\"}\n```")).toBeNull();
    expect(parseStructuredJson("```\n{\"x\": 1}\n```")).toBeNull();
  });

  it("rejects prose-wrapped JSON — no brace slicing that could mask a malformed response", () => {
    expect(
      parseStructuredJson(`Here is the requested JSON:\n\n{"documentation_reminder": "Check passport."}\n`),
    ).toBeNull();
  });

  it("rejects truncated JSON (max_tokens cutoff) instead of salvaging a partial object", () => {
    expect(parseStructuredJson(`{"packing_checklist": ["sunscreen", "passp`)).toBeNull();
  });

  it("rejects non-object JSON values — the consumer indexes string keys", () => {
    expect(parseStructuredJson(`["a", "b"]`)).toBeNull();
    expect(parseStructuredJson(`"just a string"`)).toBeNull();
    expect(parseStructuredJson(`null`)).toBeNull();
    expect(parseStructuredJson(`42`)).toBeNull();
  });

  it("rejects malformed / empty input", () => {
    expect(parseStructuredJson("{not json")).toBeNull();
    expect(parseStructuredJson("")).toBeNull();
    expect(parseStructuredJson("just prose, no braces")).toBeNull();
  });
});
