"use strict";

// D-091 slop-reduction — ESLint rule: no-orphan-todo
//
// Flags TODO/FIXME/XXX/HACK comments that lack a VALID owner or issue reference.
// Required format (one of):
//   TODO(#123): description       — issue link (PREFERRED: durable, linkable, verifiable)
//   TODO(@octocat): description   — github handle (specific person)
//   TODO(bp27-abuse-signals|operator|legal-attorney|...): description — whitelisted domain owners
//   FIXME(#456) ...                — colon optional
//
// Whitelisted bare owners (meaningful in the codebase context):
//   - legal-attorney, legal-counsel — legal/attorney review required
//   - operator — operator/manual action required
//   - usps-validator, rag-service-count, pre-cruise-emails — feature/subsystem refs
//   - bp* (e.g., bp23-tier-lookup, bp27-abuse-signals) — spec/proposal references
//
// REJECTED patterns (accumulate forever with no durable reference):
//   - TODO(notifications-dedup), TODO(owner), TODO(name) — bogus/placeholder names
//   - TODO(some-random-word) — unvalidated bare owner (doesn't match whitelist)
//
// Why: orphan TODOs accumulate because no one is named or linked durably. Issue refs
// (#N) are strongest (durable, linkable, verifiable). @handles are specific (named
// person). Bare owners are restricted to a whitelist of known domain concepts.

const MARKERS = ["TODO", "FIXME", "XXX", "HACK"];
const MARKER_GROUP = "(" + MARKERS.join("|") + ")";

// Valid owner patterns (in priority order):
//   1. #\d+ : issue reference (PREFERRED: durable, linkable)
//   2. @\w[\w-]* : GitHub handle (specific person)
//   3. Whitelisted bare owners (documented domain concepts only):
//      - legal-attorney, legal-counsel: legal/attorney review
//      - operator: operator/manual action
//      - Spec references: bp\d+[a-z0-9]*[-/\w]*, BP\d+[^)]*,  §\d+.*
//      - Subsystem names: usps-validator, rag-service-count, pre-cruise-emails, rbac*, haiku-*, help-*, prompt-\d+
//      - Person: jharvieux
//
// Rejected patterns (accumulate forever with no durable reference):
//   - Generic placeholders: owner, name, verify, notifications, part-6, etc.
//   - Undefined bare words or hyphenated names not on whitelist

// Two patterns count as a marker:
//   1. Marker at start of a comment line (the classic `// TODO: ...` slop)
//   2. Marker inside a paren-tag like `(TODO: wire X)`
// Both must have a valid owner: either #<digits>, @<handle>, or a whitelisted bare owner.
const WHITELISTED_BARE_OWNERS = [
  "legal-attorney",
  "legal-counsel",
  "operator",
  "usps-validator",
  "rag-service-count",
  "pre-cruise-emails",
  "rbac(?:[a-z0-9-]*)?", // matches rbac, rbac-tenant-admin, etc.
  "bp\\d+[a-z0-9]*[-/\\w]*", // spec refs: bp23, bp23-tier-lookup, etc.
  "BP\\d+[^)]*", // spec refs: BP19/§18, etc.
  "§\\d+[^)]*", // spec refs: §27.12-cost-display, etc.
  "haiku-[a-z0-9-]*", // haiku model features: haiku-pii-redaction, etc.
  "[a-z]+-haiku", // haiku features: help-ai-confidence-haiku, etc.
  "help-[a-z0-9-]*", // help subsystem features
  "prompt-\\d+", // numbered prompt configs: prompt-12, prompt-13, etc.
  "jharvieux",
].join("|");

const LINE_MARKER_RE = new RegExp(
  "^" + MARKER_GROUP + "\\b(?!\\s*\\((?:#\\d+|@\\w[\\w-]*|(?:" + WHITELISTED_BARE_OWNERS + "))\\))"
);
const PAREN_MARKER_RE = new RegExp(
  "\\(\\s*" + MARKER_GROUP + "\\b(?!\\s*(?:#\\d+|@\\w[\\w-]*|(?:" + WHITELISTED_BARE_OWNERS + ")|\\())"
);

module.exports = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require TODO/FIXME/XXX/HACK comments to include a valid owner or issue reference: TODO(#123), TODO(@handle), or TODO(whitelisted-owner).",
      category: "Slop reduction",
      recommended: true,
    },
    schema: [],
    messages: {
      orphanMarker:
        "{{kind}} must reference an issue ({{kind}}(#123)), a GitHub handle ({{kind}}(@user)), or a whitelisted owner. Bogus placeholders like 'notifications-dedup' or 'owner' are not allowed. Got: {{snippet}}",
    },
  },
  create(context) {
    const sourceCode = context.getSourceCode();
    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          // Walk each line of the comment body. Strip leading whitespace and
          // a leading JSDoc `*`. Check both line-start and paren-tag patterns.
          for (const rawLine of comment.value.split("\n")) {
            const line = rawLine.replace(/^\s*\*?\s*/, "");
            const lineMatch = LINE_MARKER_RE.exec(line);
            const parenMatch = PAREN_MARKER_RE.exec(line);
            const match = lineMatch || parenMatch;
            if (!match) continue;
            context.report({
              node: comment,
              messageId: "orphanMarker",
              data: {
                kind: match[1],
                snippet: line.trim().slice(0, 80),
              },
            });
            break; // one report per comment is enough
          }
        }
      },
    };
  },
};
