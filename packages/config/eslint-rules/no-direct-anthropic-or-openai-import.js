"use strict";

// §26.3a / §27 (incoming) — Forbids direct imports of @anthropic-ai/sdk
// and openai outside the AI call wrapper directory (src/lib/ai/**).
// The wrapper centralizes cost attribution, vendor-health checks, and
// fallback logic; bypassing it loses the §27.12 per-call cost tracking
// and the §26.9 vendor outage handling.
//
// Until lib/ai/call-wrapper.ts lands in BP27, the entire src/lib/ai/**
// tree is the allowlist. BP27 will tighten to the specific file.

const ALLOWED_PATH_PREFIXES = [
  "/lib/ai/",
];

const FORBIDDEN_PACKAGES = new Set([
  "@anthropic-ai/sdk",
  "openai",
]);

function isAllowedPath(filename) {
  const normalized = filename.replace(/\\/g, "/");
  return ALLOWED_PATH_PREFIXES.some((prefix) => normalized.includes(prefix));
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct @anthropic-ai/sdk or openai imports outside lib/ai/** (spec §26.3a / §27.12)",
    },
    schema: [],
    messages: {
      forbidden:
        "Direct import of {{pkg}} is not allowed here. Use lib/ai/call-wrapper.ts (lands in BP27); this enforces cost attribution and vendor outage handling.",
    },
  },
  create(context) {
    const filename = context.getFilename ? context.getFilename() : context.filename;
    if (isAllowedPath(filename)) return {};

    return {
      ImportDeclaration(node) {
        if (
          node.source &&
          typeof node.source.value === "string" &&
          FORBIDDEN_PACKAGES.has(node.source.value)
        ) {
          context.report({
            node,
            messageId: "forbidden",
            data: { pkg: node.source.value },
          });
        }
      },
      CallExpression(node) {
        if (
          (node.callee.type === "Import" ||
            (node.callee.type === "Identifier" && node.callee.name === "require")) &&
          node.arguments[0] &&
          node.arguments[0].type === "Literal" &&
          typeof node.arguments[0].value === "string" &&
          FORBIDDEN_PACKAGES.has(node.arguments[0].value)
        ) {
          context.report({
            node,
            messageId: "forbidden",
            data: { pkg: node.arguments[0].value },
          });
        }
      },
    };
  },
};
