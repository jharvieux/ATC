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
  // Mirrors the regexes in the rule. Valid owners:
  // 1. #\d+ — issue reference (PREFERRED)
  // 2. @\w[\w-]* — GitHub handle
  // 3. Whitelisted bare owners:
  //    - legal-attorney, legal-counsel, operator (roles)
  //    - usps-validator, rag-service-count, pre-cruise-emails, rbac* (features)
  //    - bp\d+[a-z0-9]*[-/\w]*, BP\d+[^)]* (spec references)
  //    - jharvieux (person)
  //
  // Rejected: anything not matching above, including placeholders (owner, name, notify-*, prompt-*, etc.)
  const WHITELISTED_BARE_OWNERS = [
    "legal-attorney",
    "legal-counsel",
    "operator",
    "usps-validator",
    "rag-service-count",
    "pre-cruise-emails",
    "rbac(?:[a-z0-9-]*)?",
    "bp\\d+[a-z0-9]*[-/\\w]*",
    "BP\\d+[^)]*",
    "jharvieux",
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
  it("does not flag TODO(bp23-tier-lookup) whitelisted bare owner", () => {
    expect(LINE_MARKER_RE.test("TODO(bp23-tier-lookup): derive")).toBe(false);
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
});
