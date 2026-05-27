"use strict";

// D-091 slop-reduction — ESLint rule: no-orphan-todo
//
// Flags TODO/FIXME/XXX/HACK comments that lack an owner or issue reference.
// Required format (one of):
//   TODO(#123): description       — issue link
//   TODO(@octocat): description   — github handle
//   TODO(owner): description       — bare owner name
//   FIXME(#456) ...                — colon optional
//
// Why: orphan TODOs accumulate and never get addressed because no one
// is named or linked. Requiring a reference keeps them actionable.

const MARKERS = ["TODO", "FIXME", "XXX", "HACK"];
const MARKER_GROUP = "(" + MARKERS.join("|") + ")";

// Two patterns count as a marker:
//   1. Marker at start of a comment line (the classic `// TODO: ...` slop)
//   2. Marker inside a paren-tag like `(TODO: wire X)`
// Both must lack an owner/issue ref (no `(owner)` or `: @owner` / `: #123`).
const LINE_MARKER_RE = new RegExp("^" + MARKER_GROUP + "\\b(?!\\s*\\()");
const PAREN_MARKER_RE = new RegExp(
  "\\(\\s*" + MARKER_GROUP + "\\b(?!\\s*[@#]|\\(|\\s+[@#])",
);

module.exports = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require TODO/FIXME/XXX/HACK comments to include an owner or issue reference: TODO(#123) or TODO(owner).",
      category: "Slop reduction",
      recommended: true,
    },
    schema: [],
    messages: {
      orphanMarker:
        "{{kind}} should include an owner or issue reference: {{kind}}(#123) or {{kind}}(owner). Got: {{snippet}}",
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
