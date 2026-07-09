// #1637 — unit tests for the debug/dev/test route guard's path matcher.

import { describe, it, expect } from "vitest";
import { forbiddenSegment } from "../../../scripts/check-debug-routes";

describe("forbiddenSegment", () => {
  it("flags a /debug/ segment", () => {
    expect(forbiddenSegment("debug/echo")).toBe("debug");
  });

  it("flags /dev and /test* segments", () => {
    expect(forbiddenSegment("dev")).toBe("dev");
    expect(forbiddenSegment("test-utils/x")).toBe("test-utils");
  });

  it("flags a (debug) route group", () => {
    expect(forbiddenSegment("(debug)/echo")).toBe("(debug)");
  });

  it("does NOT flag legitimate segments", () => {
    expect(forbiddenSegment("admin/users")).toBeNull();
    expect(forbiddenSegment("tenant/dashboard")).toBeNull();
    // 'latest' contains 'test' but is not the whole segment.
    expect(forbiddenSegment("catalog/latest")).toBeNull();
  });
});
