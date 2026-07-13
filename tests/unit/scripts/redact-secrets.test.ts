// #1784 — redactSecrets scrubs credentials that a raw caught Error might
// stringify (Postgres connection strings, Bearer tokens) before it hits a
// console.error crash handler and lands in CI logs.
//
// NON-GOAL (see scripts/lib/redact-secrets.ts): bare tokens outside a
// `Bearer ` header or connection-string URL are not redacted by design.

import { describe, it, expect } from "vitest";
import { redactSecrets } from "../../../scripts/lib/redact-secrets";

describe("redactSecrets", () => {
  it("redacts user:password from a Postgres connection string", () => {
    const err = new Error("connect failed for postgres://dbuser:s3cr3t@db.example.com:5432/main");
    expect(redactSecrets(err)).not.toContain("s3cr3t");
    expect(redactSecrets(err)).toContain("postgres://[redacted]@db.example.com:5432/main");
  });

  it("redacts a connection string with an empty username", () => {
    // postgres://:password@host is a valid form (e.g. some connection poolers);
    // the username group must match zero-or-more, not one-or-more.
    const err = new Error("connect failed for postgres://:s3cr3t@db.example.com:5432/main");
    expect(redactSecrets(err)).not.toContain("s3cr3t");
    expect(redactSecrets(err)).toContain("postgres://[redacted]@db.example.com:5432/main");
  });

  it("redacts a Bearer token", () => {
    const err = new Error("advisor fetch failed, Authorization: Bearer sbp_abc123def456 rejected");
    expect(redactSecrets(err)).not.toContain("sbp_abc123def456");
    expect(redactSecrets(err)).toContain("Bearer [redacted]");
  });

  it("redacts every credential in a message with multiple occurrences", () => {
    const msg =
      "primary postgres://a:p1@host1/db failed, replica postgres://b:p2@host2/db also failed, Bearer tok1 and Bearer tok2 both rejected";
    const err = new Error(msg);
    const redacted = redactSecrets(err);
    expect(redacted).not.toContain("p1");
    expect(redacted).not.toContain("p2");
    expect(redacted).not.toContain("tok1");
    expect(redacted).not.toContain("tok2");
    expect(redacted).toContain("postgres://[redacted]@host1/db");
    expect(redacted).toContain("postgres://[redacted]@host2/db");
    expect((redacted.match(/\[redacted\]/g) ?? []).length).toBe(4);
  });

  it("redacts the stack trace while preserving frames", () => {
    const err = new Error("connect failed for postgres://dbuser:s3cr3t@db.example.com:5432/main");
    const redacted = redactSecrets(err);
    expect(redacted).not.toContain("s3cr3t");
    expect(redacted).toContain("postgres://[redacted]@db.example.com:5432/main");
    // stack frames (the "at ..." lines) must survive, not just the message
    expect(redacted).toContain("at ");
    expect(redacted.split("\n").length).toBeGreaterThan(1);
  });

  it("falls back to message when an Error has no stack", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    err.stack = undefined;
    expect(redactSecrets(err)).toBe("connect ECONNREFUSED 127.0.0.1:5432");
  });

  it("handles non-Error values", () => {
    expect(redactSecrets("plain string with postgres://u:p@host/db")).toContain("[redacted]");
    expect(redactSecrets(42)).toBe("42");
  });

  // #1837 — verified against postgres@3.4.9 with node_modules installed:
  // postgres.js's parseUrl() calls Node's `new URL()` on the raw connection
  // string; on a malformed URL, Node's TypeError carries the credential on
  // `.input` (not `.message`/`.stack`), which a bare `console.error(err)`
  // would print via default Error formatting. redactSecrets() reads only
  // `.stack`/`.message`, so `.input` is never consumed and the credential
  // never surfaces — this pins that this genuinely-thrown Node URL error
  // shape stays safe.
  it("does not leak a credential Node's URL parser attaches to .input", () => {
    let err: unknown;
    try {
      new URL("postgres://dbuser:s3cr3tpass@");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TypeError);
    expect((err as { input?: string }).input).toBe("postgres://dbuser:s3cr3tpass@");
    expect(redactSecrets(err)).not.toContain("s3cr3tpass");
  });
});
