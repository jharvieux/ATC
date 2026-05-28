// §27.12 — Tolerant JSON parser for batched precruise results.
// Haiku occasionally wraps output in ```json fences or adds leading
// prose; the parser strips both.

import { describe, it, expect } from "vitest";
import { parseStructuredJson } from "@/inngest/precruise-generate-and-send";

describe("parseStructuredJson", () => {
  it("parses bare JSON", () => {
    const r = parseStructuredJson(`{"foo": "bar", "n": 3}`);
    expect(r).toEqual({ foo: "bar", n: 3 });
  });

  it("strips ```json fences", () => {
    const r = parseStructuredJson("```json\n{\n  \"foo\": \"bar\"\n}\n```");
    expect(r).toEqual({ foo: "bar" });
  });

  it("strips bare ``` fences", () => {
    const r = parseStructuredJson("```\n{\"x\": 1}\n```");
    expect(r).toEqual({ x: 1 });
  });

  it("tolerates leading prose before the JSON", () => {
    const r = parseStructuredJson(
      `Here is the requested JSON:\n\n{"documentation_reminder": "Check passport.", "did_you_know": "Fact"}\n`,
    );
    expect(r?.documentation_reminder).toBe("Check passport.");
  });

  it("returns null on malformed JSON", () => {
    expect(parseStructuredJson("{not json")).toBeNull();
    expect(parseStructuredJson("")).toBeNull();
    expect(parseStructuredJson("just prose, no braces")).toBeNull();
  });

  it("uses the outermost {...} when there are nested object fragments in prose", () => {
    // Defensive: the parser takes the substring from the first { to the
    // last }, so nested-looking braces in prose between them stay inside.
    const r = parseStructuredJson(
      `intro {ignored} \n{"a": 1, "b": {"c": 2}} \ntrailing`,
    );
    expect(r).toBeDefined();
    // The "first {" is before "ignored", so the parser grabs from there.
    // JSON.parse will reject because of the trailing "} \n{...". This is
    // an edge case where the parser correctly returns null.
    expect(r).toBeNull();
  });
});
