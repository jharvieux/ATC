// §25.5 — Sentry PII scrubber: redacts PII at any depth, strips PII
// query params, drops cookies header, drops request body.

import { describe, it, expect } from "vitest";
import { scrubPii, stripQueryParams } from "@/lib/sentry/pii-scrubber";

describe("scrubPii — recursive redaction", () => {
  it("redacts top-level PII keys", () => {
    const out = scrubPii({ email: "a@b.com", name: "Sarah" }) as Record<string, unknown>;
    expect(out.email).toBe("[redacted]");
    expect(out.name).toBe("Sarah");
  });

  it("redacts deeply nested PII", () => {
    const out = scrubPii({
      a: { b: { c: { phone: "555-0100", note: "ok" } } },
    }) as { a: { b: { c: { phone: string; note: string } } } };
    expect(out.a.b.c.phone).toBe("[redacted]");
    expect(out.a.b.c.note).toBe("ok");
  });

  it("redacts inside arrays", () => {
    const out = scrubPii({
      passengers: [
        { legal_first_name: "A", legal_last_name: "B" },
        { legal_first_name: "C", legal_last_name: "D" },
      ],
    }) as { passengers: Array<{ legal_first_name: string; legal_last_name: string }> };
    expect(out.passengers[0]!.legal_first_name).toBe("[redacted]");
    expect(out.passengers[1]!.legal_last_name).toBe("[redacted]");
  });

  it("strips PII query params from URL fields", () => {
    const out = scrubPii({ url: "/api/x?token=secret123&keep=this" }) as { url: string };
    expect(out.url).toContain("token=%5Bredacted%5D");
    expect(out.url).toContain("keep=this");
  });

  it("drops cookie headers", () => {
    const out = scrubPii({
      headers: { Cookie: "session=abc", "User-Agent": "test", "x-foo": "bar" },
    }) as { headers: Record<string, string> };
    expect(out.headers.Cookie).toBeUndefined();
    expect(out.headers["User-Agent"]).toBe("test");
  });
});

describe("stripQueryParams", () => {
  it("redacts known PII params", () => {
    expect(stripQueryParams("/path?email=x@y.com&keep=ok")).toBe("/path?email=%5Bredacted%5D&keep=ok");
  });
  it("safely round-trips when no PII params are present", () => {
    expect(stripQueryParams("/clean?foo=bar")).toBe("/clean?foo=bar");
  });
});
