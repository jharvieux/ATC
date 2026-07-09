// #1675 — pins escapeHtml's 5-entity behavior (#1634 consolidated 12+
// divergent implementations onto this one function per #1598, which was
// specifically about the quote/apostrophe escaping gap in attribute
// contexts). Without this test, a future "simplification" back to the old
// 3-entity (& < >) behavior would regress the XSS-adjacent bug #1598 fixed,
// with nothing to catch it.

import { describe, expect, it } from "vitest";
import { escapeHtml } from "@/lib/utils";

describe("escapeHtml", () => {
  it("escapes &", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes <", () => {
    expect(escapeHtml("<script")).toBe("&lt;script");
  });

  it("escapes >", () => {
    expect(escapeHtml("a>b")).toBe("a&gt;b");
  });

  it("escapes \" (the #1598 gap — attribute-context injection)", () => {
    expect(escapeHtml('say "hi"')).toBe("say &quot;hi&quot;");
  });

  it("escapes ' (the #1598 gap — attribute-context injection)", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("escapes all five entities together in mixed content", () => {
    const input = `<a href="x" onclick='alert(1)'>Tom & Jerry's "great" show</a>`;
    const expected =
      "&lt;a href=&quot;x&quot; onclick=&#39;alert(1)&#39;&gt;Tom &amp; Jerry&#39;s &quot;great&quot; show&lt;/a&gt;";
    expect(escapeHtml(input)).toBe(expected);
  });
});
