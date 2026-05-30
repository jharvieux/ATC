// §17.7 — safeNextFor (parse-then-check-origin).
//
// The cases below pin every bypass vector named in the OWASP open-redirect
// guide and the HackTricks / undercodetesting writeups. If any of them
// regresses to a non-null return on the trusted origin, an attacker who
// can put a value into the `?next=` query gets a redirect off-host.

import { describe, it, expect } from "vitest";
import { safeNextFor } from "@/lib/auth/safe-redirect";

const ORIGIN = "https://tenant.example.com";

describe("safeNextFor — safe inputs", () => {
  it("accepts a simple same-origin path and returns the normalized form", () => {
    const r = safeNextFor("/crm/bookings", ORIGIN);
    expect(r?.path).toBe("/crm/bookings");
  });

  it("preserves the query string and hash on a same-origin path", () => {
    const r = safeNextFor("/crm/bookings?focus=42#row", ORIGIN);
    expect(r?.path).toBe("/crm/bookings?focus=42#row");
  });

  it("returns null for null / undefined / non-string", () => {
    expect(safeNextFor(null, ORIGIN)).toBeNull();
    expect(safeNextFor(undefined, ORIGIN)).toBeNull();
    expect(safeNextFor("", ORIGIN)).toBeNull();
  });

  it("returns null for paths over the length cap (DoS guard)", () => {
    const oversized = "/" + "a".repeat(600);
    expect(safeNextFor(oversized, ORIGIN)).toBeNull();
  });
});

describe("safeNextFor — open-redirect bypass vectors", () => {
  it("rejects protocol-relative //evil.com (parser resolves origin to evil.com)", () => {
    expect(safeNextFor("//evil.com", ORIGIN)).toBeNull();
  });

  it("rejects triple-slash ///evil.com (some legacy parsers were tricked)", () => {
    expect(safeNextFor("///evil.com", ORIGIN)).toBeNull();
  });

  it("rejects absolute https://evil.com (parser keeps the absolute origin)", () => {
    expect(safeNextFor("https://evil.com", ORIGIN)).toBeNull();
  });

  it("rejects userinfo trick https://tenant.example.com@evil.com (browser lands on evil.com)", () => {
    expect(
      safeNextFor("https://tenant.example.com@evil.com/", ORIGIN),
    ).toBeNull();
  });

  it("rejects backslash variants /\\evil.com that some legacy parsers confuse with //", () => {
    expect(safeNextFor("/\\evil.com", ORIGIN)).toBeNull();
  });

  it("rejects CRLF in the input (header injection pre-parse)", () => {
    expect(safeNextFor("/x\r\nLocation: evil", ORIGIN)).toBeNull();
    expect(safeNextFor("/x\nfoo", ORIGIN)).toBeNull();
  });

  it("rejects null byte / control chars", () => {
    expect(safeNextFor("/x\x00y", ORIGIN)).toBeNull();
  });

  it("rejects /\\\\evil.com (double backslash)", () => {
    expect(safeNextFor("/\\\\evil.com", ORIGIN)).toBeNull();
  });

  it("rejects a same-origin path that bounces through /auth/* (signup's legacy /auth/callback?flow=)", () => {
    expect(safeNextFor("/auth/callback?flow=customer", ORIGIN)).toBeNull();
    expect(safeNextFor("/auth", ORIGIN)).toBeNull();
    expect(safeNextFor("/auth/error", ORIGIN)).toBeNull();
  });

  it("rejects a same-origin path that bounces through /api/* (not a page)", () => {
    expect(safeNextFor("/api/foo", ORIGIN)).toBeNull();
    expect(safeNextFor("/api", ORIGIN)).toBeNull();
  });

  it("URL-encoded //evil ('/%2F%2Fevil.com') stays on our origin — accepted as a literal same-origin path", () => {
    // The parser keeps %2F as a path segment; the resulting target lives
    // on our origin. Browsers will NOT decode and re-interpret it as
    // protocol-relative on a Location header. Safe.
    const r = safeNextFor("/%2F%2Fevil.com", ORIGIN);
    expect(r?.path).toBe("/%2F%2Fevil.com");
  });

  it("URL-encoded absolute (%2F%2Fhost) starting without a leading literal slash → parser resolves on our origin", () => {
    // Per WHATWG URL, a relative reference without a leading scheme stays
    // resolved against the base origin. The path is treated as same-origin
    // literal. Whitelist permits.
    const r = safeNextFor("%2Fpath", ORIGIN);
    expect(r?.path).toBe("/%2Fpath");
  });

  it("rejects an at-sign in front of a path (parser may treat as userinfo of base)", () => {
    // `//attacker.tld` already rejected above. Belt-and-suspenders: when
    // the input has scheme-style content, parser-based origin check is
    // what saves us — verify the parser disagrees with our trusted origin.
    expect(safeNextFor("javascript:alert(1)", ORIGIN)).toBeNull();
    expect(safeNextFor("data:text/html,<script>", ORIGIN)).toBeNull();
  });
});

describe("safeNextFor — edge cases", () => {
  it("returns the root path '/' as itself (safe, useful for explicit no-op)", () => {
    expect(safeNextFor("/", ORIGIN)?.path).toBe("/");
  });

  it("origin equality is exact — same-host but different scheme/port is rejected", () => {
    expect(
      safeNextFor("http://tenant.example.com/crm", ORIGIN),
    ).toBeNull();
    expect(
      safeNextFor("https://tenant.example.com:8080/crm", ORIGIN),
    ).toBeNull();
  });
});
