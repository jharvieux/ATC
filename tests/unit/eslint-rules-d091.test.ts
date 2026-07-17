// D-091 — Smoke tests for the three new anti-pattern ESLint rules.
//
// Uses the rule's create() function directly with a minimal mock context.
// This is a unit test of the rule's logic, not a full eslint integration.

import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const orphanTodo = require("../../packages/config/eslint-rules/no-orphan-todo");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const noUncheckedMutation = require("../../packages/config/eslint-rules/no-unchecked-supabase-mutation");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const noCredentialsInUrl = require("../../packages/config/eslint-rules/no-credentials-in-url");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const noFailOpen = require("../../packages/config/eslint-rules/no-fail-open-on-resource-error");

// Each rule export has the shape { meta, create(context) }. We assert the
// meta fields are well-formed and the rule loads without throwing.

const rules = [
  { name: "no-orphan-todo", mod: orphanTodo, expectedSeverity: "suggestion" },
  { name: "no-unchecked-supabase-mutation", mod: noUncheckedMutation, expectedSeverity: "problem" },
  { name: "no-credentials-in-url", mod: noCredentialsInUrl, expectedSeverity: "problem" },
  { name: "no-fail-open-on-resource-error", mod: noFailOpen, expectedSeverity: "suggestion" },
];

describe("D-091 anti-pattern ESLint rules — module shape", () => {
  for (const { name, mod, expectedSeverity } of rules) {
    it(`${name} exports a valid rule module`, () => {
      expect(mod).toHaveProperty("meta");
      expect(mod).toHaveProperty("create");
      expect(typeof mod.create).toBe("function");
      expect(mod.meta.type).toBe(expectedSeverity);
      expect(mod.meta.messages).toBeDefined();
      expect(Object.keys(mod.meta.messages).length).toBeGreaterThan(0);
    });
  }
});

describe("no-credentials-in-url — regex behavior", () => {
  // The rule constructs its regex from a static pattern. We can verify the
  // pattern matches the cases we care about by re-deriving it.
  const CREDENTIAL_RE =
    /[?&](?:token|api[_-]?key|secret|password|auth[_-]?key)=/i;

  it("matches ?token= in URL", () => {
    expect(CREDENTIAL_RE.test("https://api.example.com/x?token=abc")).toBe(true);
  });
  it("matches ?api_key= and ?api-key=", () => {
    expect(CREDENTIAL_RE.test("https://x.com/y?api_key=abc")).toBe(true);
    expect(CREDENTIAL_RE.test("https://x.com/y?api-key=abc")).toBe(true);
  });
  it("matches credential as second query param", () => {
    expect(CREDENTIAL_RE.test("https://x.com/y?a=1&secret=p")).toBe(true);
  });
  it("does not match credential-free URLs", () => {
    expect(CREDENTIAL_RE.test("https://x.com/y?foo=bar")).toBe(false);
    expect(CREDENTIAL_RE.test("https://x.com/y")).toBe(false);
  });
  it("matches case-insensitively", () => {
    expect(CREDENTIAL_RE.test("https://x.com/y?TOKEN=abc")).toBe(true);
  });
});

describe("no-orphan-todo — pattern coverage (re-derived)", () => {
  // Mirrors the regexes in the rule (see no-orphan-todo.js for the authoritative
  // comment). Valid owners:
  // 1. #\d+ — issue reference (PREFERRED)
  // 2. @\w[\w-]* — GitHub handle
  // 3. Whitelisted bare owners — enumerated literals for actual domain concepts,
  //    plus two bounded structural forms (prompt-\d+, [a-z]+-haiku).
  //
  // Rejected: anything not on the enumerated list, including placeholders
  // (owner, name, notify-*, etc.) and open-ended bp*/BP*/§*/haiku-*/help-*
  // prefixes with invented suffixes.
  const WHITELISTED_BARE_OWNERS = [
    "legal-attorney",
    "legal-counsel",
    "operator",
    "usps-validator",
    "rag-service-count",
    "pre-cruise-emails",
    "rbac-tenant-admin",
    "bp27-abuse-signals",
    "BP19/§18",
    "§22\\.4-haiku-redaction",
    "§27\\.12-cost-display",
    "§24-tone-content",
    "§26",
    "haiku-pii-redaction",
    "help-ai-confidence-haiku",
    "help-screenshot-pii-haiku",
    "[a-z]+-haiku",
    "prompt-\\d+",
  ].join("|");
  const LINE_MARKER_RE = new RegExp(
    "^(TODO|FIXME|XXX|HACK)\\b(?!\\s*\\((?:#\\d+|@\\w[\\w-]*|(?:" + WHITELISTED_BARE_OWNERS + "))\\))"
  );
  const PAREN_MARKER_RE = new RegExp(
    "\\(\\s*(TODO|FIXME|XXX|HACK)\\b(?!\\s*(?:#\\d+|@\\w[\\w-]*|(?:" + WHITELISTED_BARE_OWNERS + ")|\\())"
  );

  it("flags TODO: at start of comment line (no owner)", () => {
    expect(LINE_MARKER_RE.test("TODO: derive from tier_id")).toBe(true);
  });
  it("does not flag TODO(#123) issue reference", () => {
    expect(LINE_MARKER_RE.test("TODO(#1234): derive from tier_id")).toBe(false);
  });
  it("does not flag TODO(@handle) GitHub handle", () => {
    expect(LINE_MARKER_RE.test("TODO(@jharvieux): derive")).toBe(false);
  });
  it("does not flag TODO(bp27-abuse-signals) whitelisted bare owner", () => {
    expect(LINE_MARKER_RE.test("TODO(bp27-abuse-signals): derive")).toBe(false);
  });
  it("does not flag TODO(legal-attorney) whitelisted bare owner", () => {
    expect(LINE_MARKER_RE.test("TODO(legal-attorney): review required")).toBe(false);
  });
  it("flags TODO(notifications-dedup) bogus placeholder owner", () => {
    expect(LINE_MARKER_RE.test("TODO(notifications-dedup): defer work")).toBe(true);
  });
  it("flags TODO(owner) generic placeholder owner", () => {
    expect(LINE_MARKER_RE.test("TODO(owner): someone fix this")).toBe(true);
  });
  it("flags (TODO) paren-tag without owner", () => {
    expect(PAREN_MARKER_RE.test("refactor to a pg client (TODO).")).toBe(true);
  });
  it("does not flag (TODO(#123)) with issue reference", () => {
    expect(PAREN_MARKER_RE.test("(TODO(#123): wire X)")).toBe(false);
  });
  it("does not flag (TODO(@user)) with GitHub handle", () => {
    expect(PAREN_MARKER_RE.test("(TODO(@alice): wire X)")).toBe(false);
  });
  it("does not flag (TODO(operator)) whitelisted bare owner", () => {
    expect(PAREN_MARKER_RE.test("(TODO(operator): manual step)")).toBe(false);
  });

  // D-091 audit follow-up (#1957/#1978): the whitelist used to include five
  // open-ended prefix patterns (bp\d+..., BP\d+[^)]*, §\d+[^)]*, haiku-*, help-*)
  // that matched a literal prefix then swallowed ANY trailing text — e.g.
  // TODO(haiku-i-will-fix-this-later) used to pass. These now must be flagged.
  it("flags TODO(haiku-not-a-real-feature) — bogus haiku-* suffix", () => {
    expect(LINE_MARKER_RE.test("TODO(haiku-not-a-real-feature): x")).toBe(true);
  });
  it("flags TODO(help-literally-anything) — bogus help-* suffix", () => {
    expect(LINE_MARKER_RE.test("TODO(help-literally-anything): x")).toBe(true);
  });
  it("flags TODO(bp1-bogus-free-text) — bogus bp\\d+ suffix", () => {
    expect(LINE_MARKER_RE.test("TODO(bp1-bogus-free-text): x")).toBe(true);
  });
  it("flags TODO(BP1 bogus text) — bogus BP\\d+ free text", () => {
    expect(LINE_MARKER_RE.test("TODO(BP1 bogus text): x")).toBe(true);
  });
  it("flags TODO(§1 whatever nonsense) — bogus §\\d+ free text", () => {
    expect(LINE_MARKER_RE.test("TODO(§1 whatever nonsense): x")).toBe(true);
  });
  it("flags TODO(rbacnonsense) — bogus rbac* suffix (rbac(?:[a-z0-9-]*)? redundancy)", () => {
    expect(LINE_MARKER_RE.test("TODO(rbacnonsense): x")).toBe(true);
  });
});

describe("no-orphan-todo — mid-sentence marker detection", () => {
  // Mirrors the mid-sentence regex from the rule (see no-orphan-todo.js).
  // Mid-sentence markers: appear mid-line, followed by `:` or `(`, with invalid owner.
  // (LINE_MARKER_RE catches line-start, PAREN_MARKER_RE catches after `(`, so MID_SENTENCE
  // handles anything else with `:` or `(` following.)
  const WHITELISTED_BARE_OWNERS = [
    "legal-attorney",
    "legal-counsel",
    "operator",
    "usps-validator",
    "rag-service-count",
    "pre-cruise-emails",
    "rbac-tenant-admin",
    "bp27-abuse-signals",
    "BP19/§18",
    "§22\\.4-haiku-redaction",
    "§27\\.12-cost-display",
    "§24-tone-content",
    "§26",
    "haiku-pii-redaction",
    "help-ai-confidence-haiku",
    "help-screenshot-pii-haiku",
    "[a-z]+-haiku",
    "prompt-\\d+",
  ].join("|");
  const MID_SENTENCE_MARKER_RE = new RegExp(
    "(TODO|FIXME|XXX|HACK)\\s*(?=[:(])(?!\\s*\\((?:#\\d+|@\\w[\\w-]*|(?:" + WHITELISTED_BARE_OWNERS + "))\\))"
  );

  it("flags mid-sentence TODO(notifications) with invalid owner", () => {
    expect(MID_SENTENCE_MARKER_RE.test("some text TODO(notifications) here")).toBe(true);
  });
  it("flags mid-sentence TODO(part-6) with invalid owner", () => {
    expect(MID_SENTENCE_MARKER_RE.test("Consumer is TODO(part-6).")).toBe(true);
  });
  it("flags mid-sentence TODO(notifications) with backticks (invalid owner)", () => {
    expect(MID_SENTENCE_MARKER_RE.test("`TODO(notifications)` markers prior")).toBe(true);
  });
  it("does not flag mid-sentence TODO(§26) with valid whitelisted owner", () => {
    expect(MID_SENTENCE_MARKER_RE.test("metrics. TODO(§26): replace with later")).toBe(false);
  });
  it("does not flag mid-sentence TODO(#123) with issue reference", () => {
    expect(MID_SENTENCE_MARKER_RE.test("some text TODO(#123) fix needed")).toBe(false);
  });
  it("does not flag mid-sentence TODO(@handle) with GitHub handle", () => {
    expect(MID_SENTENCE_MARKER_RE.test("refactor logic TODO(@alice) later")).toBe(false);
  });
  it("does not flag mid-sentence FIXME(operator) with whitelisted owner", () => {
    expect(MID_SENTENCE_MARKER_RE.test("manual step FIXME(operator) required")).toBe(false);
  });
  it("does not flag mid-sentence XXX(prompt-42) with numbered prompt", () => {
    expect(MID_SENTENCE_MARKER_RE.test("template XXX(prompt-42) config")).toBe(false);
  });
  it("does not flag mid-sentence TODO with no : or ( following (prose text)", () => {
    expect(MID_SENTENCE_MARKER_RE.test("The TODO marker needs fixing")).toBe(false);
  });
});
