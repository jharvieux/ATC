// #1851 audit — nightly-full-test.yml's failing-test/unhandled-error
// extractors + the redaction pass that runs before their output lands in a
// PUBLIC GitHub issue body previously lived inline in the workflow's `run:`
// blocks with zero test coverage. Pins the three fixture shapes the
// extractors must handle (per-assertion failure, suite-level crash with
// empty assertionResults, ANSI unhandled-error banner — see #1833) and pins
// finding 1's redaction (fake postgres URL, fake Bearer token, fake
// known-env-value match) so a regression here can't silently leak a
// credential shape into a public issue again.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redact, extractFailingList, extractUnhandledSection } from "../../../scripts/parse-nightly-failures.mjs";

const FIXTURES = join(__dirname, "../../fixtures/nightly-failures");
const readFixture = (name: string) => readFileSync(join(FIXTURES, name), "utf-8");

describe("extractFailingList", () => {
  it("surfaces a per-assertion failure with its full ancestor-title path", () => {
    const result = extractFailingList(readFixture("per-assertion-failure.json"));
    expect(result).toBe("- `apps/main/test/unit/lib/example.test.ts` › exampleFn › edge cases › throws on invalid input");
    // the passing assertion in the same file must not appear
    expect(result).not.toContain("returns the expected value");
  });

  it("falls back to the suite message when a whole file crashes with no assertionResults (#1833)", () => {
    const result = extractFailingList(readFixture("suite-crash-empty-assertions.json"));
    expect(result).toBe(
      "- `apps/main/test/unit/lib/broken-hook.test.ts` — suite failed: Error: beforeAll hook failed: connection refused",
    );
  });

  it("reports no per-test detail when testResults is empty", () => {
    expect(extractFailingList('{"testResults": []}')).toBe("(no per-test detail captured; see run logs)");
  });
});

describe("extractUnhandledSection", () => {
  it("strips ANSI codes and extracts the unhandled-error banner + context (#1833)", () => {
    const result = extractUnhandledSection(readFixture("unhandled-error-ansi.log"));
    expect(result).toContain("**Unhandled errors (console output)**:");
    expect(result).toContain("Vitest caught 1 unhandled error during the test run");
    // ANSI escape codes must not survive into the issue body
    expect(result).not.toContain("\x1b[");
  });

  it("returns an empty string when no unhandled-error banner is present", () => {
    expect(extractUnhandledSection("stdout | some.test.ts > passes fine\nTest Files  1 passed (1)\n")).toBe("");
  });
});

describe("redact", () => {
  it("scrubs a fake postgres connection string (finding 1)", () => {
    const out = redact("connect failed for postgres://ci_user:s3cr3t_fake@db.example.internal:5432/testdb", {});
    expect(out).not.toContain("s3cr3t_fake");
    expect(out).not.toContain("ci_user");
    expect(out).toBe("connect failed for postgres://REDACTED@db.example.internal:5432/testdb");
  });

  it("scrubs a fake Bearer token (finding 1)", () => {
    const out = redact("Authorization: Bearer fake-test-token-abcdef123456 rejected", {});
    expect(out).not.toContain("fake-test-token-abcdef123456");
    expect(out).toBe("Authorization: Bearer REDACTED rejected");
  });

  it("scrubs an exact known-secret-env-value match with no postgres:// or Bearer shape (finding 1)", () => {
    const fakeStripeKey = "sk_test_fake1234567890abcdef";
    const out = redact(`upstream rejected key ${fakeStripeKey}`, { STRIPE_SECRET_KEY: fakeStripeKey });
    expect(out).not.toContain(fakeStripeKey);
    expect(out).toBe("upstream rejected key [REDACTED:STRIPE_SECRET_KEY]");
  });

  it("does not redact short/placeholder env values (avoids clobbering unrelated text)", () => {
    const out = redact("the count is 12345", { SUPABASE_DB_URL: "short" });
    expect(out).toBe("the count is 12345");
  });

  it("end-to-end: the ANSI unhandled-error fixture's embedded fake credentials are scrubbed after extraction", () => {
    const section = extractUnhandledSection(readFixture("unhandled-error-ansi.log"));
    const redacted = redact(section, {});
    expect(redacted).not.toContain("not_a_real_password_1234");
    expect(redacted).not.toContain("fake-test-token-abcdef123456");
    expect(redacted).toContain("postgres://REDACTED@fake-db.example.internal:5432/testdb");
    expect(redacted).toContain("Bearer REDACTED");
  });
});
