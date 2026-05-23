"use strict";

// §26.3a / §27.12 — Direct imports of @anthropic-ai/sdk and openai are
// allowed in EXACTLY ONE file: apps/main/src/lib/ai/call-wrapper.ts.
// The wrapper centralizes:
//   • per-call cost attribution (ai_call_log + tenant_usage_metrics)
//   • model downgrade selection at AI-cost soft1/soft2 (§27.6)
//   • vendor-health success/failure recording (§26.9)
//
// BP26 staged this rule off until BP27's wrapper existed. BP27 tightens
// the allowlist to just the wrapper file and flips the rule to "error"
// in apps/main/.eslintrc.

const ALLOWED_PATH_SUFFIXES = [
  "/lib/ai/call-wrapper.ts",
  // The pricing catalog imports vendor types only, not the SDK client.
  // Listed here so a future operator adding `import { ... } from "openai"`
  // for typed pricing structures doesn't get blocked.
  "/lib/ai/pricing.ts",
];

const FORBIDDEN_PACKAGES = new Set([
  "@anthropic-ai/sdk",
  "openai",
]);

function isAllowedPath(filename) {
  const normalized = filename.replace(/\\/g, "/");
  return ALLOWED_PATH_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct @anthropic-ai/sdk or openai imports outside lib/ai/call-wrapper.ts (spec §26.3a / §27.12)",
    },
    schema: [],
    messages: {
      forbidden:
        "Direct import of {{pkg}} is not allowed here. Use instrumentedClaudeCall / instrumentedOpenAIEmbedding from lib/ai/call-wrapper.ts to ensure cost attribution + vendor-health tracking.",
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
