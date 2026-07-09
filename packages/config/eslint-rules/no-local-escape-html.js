"use strict";

// Shift-left guard (#1613 item 3, follow-up to #1598 escapeHtml consolidation).
//
// Before #1598 the codebase had 12+ local `escapeHtml` copies with inconsistent
// coverage — most did not escape quotes, so several were XSS-unsafe in attribute
// context. #1598 consolidated to ONE definition (apps/main/src/lib/utils.ts).
// This rule freezes that: any new local `escapeHtml` declaration (function or
// const-assigned function) outside the canonical module is an error — import the
// shared one instead.
//
// Canonical definition: src/lib/utils.ts (exempt).

const CANONICAL_SUFFIX = "/lib/utils.ts";

function isCanonicalFile(filename) {
  return filename.replace(/\\/g, "/").endsWith(CANONICAL_SUFFIX);
}

function isFunctionInit(init) {
  return (
    init &&
    (init.type === "FunctionExpression" || init.type === "ArrowFunctionExpression")
  );
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow local escapeHtml definitions — import the single consolidated one from lib/utils (#1598).",
      category: "Security",
      recommended: true,
    },
    schema: [],
    messages: {
      localEscapeHtml:
        "Local escapeHtml definition is forbidden. Import { escapeHtml } from the shared lib/utils module — a second copy risks the quote-escaping drift #1598 fixed.",
    },
  },
  create(context) {
    const filename = context.getFilename ? context.getFilename() : context.filename;
    if (isCanonicalFile(filename)) return {};

    return {
      FunctionDeclaration(node) {
        if (node.id && node.id.name === "escapeHtml") {
          context.report({ node: node.id, messageId: "localEscapeHtml" });
        }
      },
      VariableDeclarator(node) {
        if (
          node.id.type === "Identifier" &&
          node.id.name === "escapeHtml" &&
          isFunctionInit(node.init)
        ) {
          context.report({ node: node.id, messageId: "localEscapeHtml" });
        }
      },
    };
  },
};
