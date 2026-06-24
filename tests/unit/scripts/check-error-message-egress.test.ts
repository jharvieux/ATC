// #1393/G1 — unit tests for the error-message-egress guard's matcher.
//
// Pins what counts as a violation (raw error .message/.details echoed as a
// response-object value) vs. what must NOT (server-side logging, string
// literals, comments). A regression here would either leak schema (false
// negative) or spam the baseline (false positive).

import { describe, it, expect } from "vitest";
import { findEgress } from "../../../scripts/check-error-message-egress";

const keys = (src: string): string[] => findEgress("r.ts", src).map((e) => e.snippet);

describe("findEgress — flags raw error egress into a response object", () => {
  it("flags detail: error.message", () => {
    expect(keys(`return Response.json({ error: "x", detail: error.message }, { status: 500 });`)).toContain(
      "detail: error.message",
    );
  });

  it("flags a template-literal interpolation of .message", () => {
    expect(keys('await send({ type: "error", message: `failed: ${createErr?.message}` });').length).toBe(1);
  });

  it("flags error: result.error.message (Supabase) and .details", () => {
    expect(keys(`return Response.json({ error: queryErr.details });`)).toContain("error: queryErr.details");
  });
});

describe("findEgress — does NOT flag safe forms", () => {
  it("ignores string-literal messages", () => {
    expect(keys(`await send({ type: "error", message: "Something went wrong", ref });`)).toEqual([]);
  });

  it("ignores server-side logging (no response-object key)", () => {
    expect(keys(`console.error("[chat] ref=%s", ref, err); logger.warn(err.message);`)).toEqual([]);
  });

  it("ignores dbErrorResponse usage", () => {
    expect(keys(`return dbErrorResponse(error);`)).toEqual([]);
  });

  it("skips commented-out code", () => {
    expect(keys(`// detail: error.message  (old, removed)`)).toEqual([]);
  });
});

describe("findEgress — key format", () => {
  it("keys by relpath::normalized-snippet", () => {
    const e = findEgress("apps/main/src/app/api/x/route.ts", `{ detail: err.message }`);
    expect(e[0]?.key).toBe("apps/main/src/app/api/x/route.ts::detail: err.message");
  });
});
