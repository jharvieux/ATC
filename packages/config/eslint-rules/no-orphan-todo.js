"use strict";

// D-091 slop-reduction — ESLint rule: no-orphan-todo
//
// Flags TODO/FIXME/XXX/HACK comments that lack a VALID owner or issue reference.
// Required format (one of):
//   TODO(#123): description       — issue link (PREFERRED: durable, linkable, verifiable)
//   TODO(@octocat): description   — github handle (specific person)
//   TODO(<whitelisted-owner>): description — enumerated domain owner (see below)
//   FIXME(#456) ...                — colon optional
//
// Why: orphan TODOs accumulate because no one is named or linked durably. Issue refs
// (#N) are strongest (durable, linkable, verifiable). @handles are specific (named
// person). Bare owners are restricted to an ENUMERATED whitelist of the actual
// identifiers in use in this codebase — no open-ended prefix patterns (bp*, BP*,
// §*, haiku-*, help-*), since those accept arbitrary trailing text and defeat the
// whole point (e.g. TODO(haiku-i-will-fix-this-later) used to pass).

const MARKERS = ["TODO", "FIXME", "XXX", "HACK"];
const MARKER_GROUP = "(" + MARKERS.join("|") + ")";

// Valid owner patterns (in priority order):
//   1. #\d+ : issue reference (PREFERRED: durable, linkable)
//   2. @\w[\w-]* : GitHub handle (specific person)
//   3. Whitelisted bare owners — enumerated literals for actual domain concepts
//      found in the codebase, plus two bounded structural forms (prompt-\d+ and
//      [a-z]+-haiku — single-segment prefixes only, can't swallow free text).
//
// Rejected: anything not on the list below, including generic placeholders
// (owner, name, verify, notifications, part-6) and bogus/invented owners.
//
// Three patterns count as a marker:
//   1. Marker at start of a comment line (the classic `// TODO: ...` slop)
//   2. Marker inside a paren-tag like `(TODO: wire X)`
//   3. Marker mid-sentence: preceded by space, not at line-start, not in parens
// All must have a valid owner: either #<digits>, @<handle>, or a whitelisted bare owner.
const WHITELISTED_BARE_OWNERS = [
  // Roles
  "legal-attorney",
  "legal-counsel",
  "operator",
  // Subsystem/feature refs
  "usps-validator",
  "rag-service-count",
  "pre-cruise-emails",
  "rbac-tenant-admin",
  // Spec references (§N, BPN) — enumerated literals, not open-ended
  "bp27-abuse-signals",
  "BP19/§18",
  "§22\\.4-haiku-redaction",
  "§27\\.12-cost-display",
  "§24-tone-content",
  "§26",
  // Haiku model features — enumerated literals, not open-ended
  "haiku-pii-redaction",
  "help-ai-confidence-haiku",
  "help-screenshot-pii-haiku",
  "[a-z]+-haiku", // bounded structural form: tone-haiku, etc.
  // Numbered prompt configs — bounded structural form
  "prompt-\\d+",
].join("|");

const LINE_MARKER_RE = new RegExp(
  "^" + MARKER_GROUP + "\\b(?!\\s*\\((?:#\\d+|@\\w[\\w-]*|(?:" + WHITELISTED_BARE_OWNERS + "))\\))"
);
const PAREN_MARKER_RE = new RegExp(
  "\\(\\s*" + MARKER_GROUP + "\\b(?!\\s*(?:#\\d+|@\\w[\\w-]*|(?:" + WHITELISTED_BARE_OWNERS + ")|\\())"
);
const MID_SENTENCE_MARKER_RE = new RegExp(
  MARKER_GROUP + "\\s*(?=[:(])(?!\\s*\\((?:#\\d+|@\\w[\\w-]*|(?:" + WHITELISTED_BARE_OWNERS + "))\\))"
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
          // a leading JSDoc `*`. Check line-start, paren-tag, and mid-sentence patterns.
          for (const rawLine of comment.value.split("\n")) {
            const line = rawLine.replace(/^\s*\*?\s*/, "");
            const lineMatch = LINE_MARKER_RE.exec(line);
            const parenMatch = PAREN_MARKER_RE.exec(line);
            const midMatch = MID_SENTENCE_MARKER_RE.exec(line);
            const match = lineMatch || parenMatch || midMatch;
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
