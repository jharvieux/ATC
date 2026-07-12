// #1784 — redactSecrets scrubs credentials that a raw caught Error might
// stringify (Postgres connection strings, Bearer tokens) before it hits a
// console.error crash handler and lands in CI logs.

import { describe, it, expect } from "vitest";
import { redactSecrets } from "../../../scripts/lib/redact-secrets";

describe("redactSecrets", () => {
  it("redacts user:password from a Postgres connection string", () => {
    const err = new Error("connect failed for postgres://dbuser:s3cr3t@db.example.com:5432/main");
    expect(redactSecrets(err)).not.toContain("s3cr3t");
    expect(redactSecrets(err)).toContain("postgres://[redacted]@db.example.com:5432/main");
  });

  it("redacts a Bearer token", () => {
    const err = new Error("advisor fetch failed, Authorization: Bearer sbp_abc123def456 rejected");
    expect(redactSecrets(err)).not.toContain("sbp_abc123def456");
    expect(redactSecrets(err)).toContain("Bearer [redacted]");
  });

  it("leaves ordinary error messages untouched", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    expect(redactSecrets(err)).toBe("connect ECONNREFUSED 127.0.0.1:5432");
  });

  it("handles non-Error values", () => {
    expect(redactSecrets("plain string with postgres://u:p@host/db")).toContain("[redacted]");
    expect(redactSecrets(42)).toBe("42");
  });
});
