"use strict";

// BP31 §32.7.1 — Direct imports of @octokit/* packages are allowed only in
// the two GitHub wrapper files:
//   • apps/main/src/lib/github/auth.ts    — App auth + installation token
//   • apps/main/src/lib/github/issues.ts  — issue creation + close + PII pipeline
//
// All other callers go through those two wrappers. The wrappers centralize:
//   • token minting + 50-min in-process cache
//   • §32.7.6 PII redaction before any free-text leaves the platform
//   • §32.7.4 issue body construction + tenant_id_hash
//   • §32.7.5 resilience (retry + quarantine routing)
//
// Same hard-fail pattern as the BP26 no-direct-service-role-import and
// the BP27 no-direct-anthropic-or-openai-import rules.

const ALLOWED_PATH_SUFFIXES = [
  "/lib/github/auth.ts",
  "/lib/github/issues.ts",
];

const FORBIDDEN_PACKAGE_PREFIXES = ["@octokit/"];

function isAllowedPath(filename) {
  const normalized = filename.replace(/\\/g, "/");
  return ALLOWED_PATH_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function isForbidden(spec) {
  return (
    typeof spec === "string" &&
    FORBIDDEN_PACKAGE_PREFIXES.some((prefix) => spec.startsWith(prefix))
  );
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct @octokit/* imports outside lib/github/ (spec §32.7.1)",
    },
    schema: [],
    messages: {
      forbidden:
        "Direct import of {{pkg}} is not allowed here. Use the wrappers in apps/main/src/lib/github/ to ensure PII redaction, tenant_id hashing, and resilience routing run before any data reaches GitHub.",
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
          isForbidden(node.source.value)
        ) {
          context.report({
            node,
            messageId: "forbidden",
            data: { pkg: node.source.value },
          });
        }
      },
    };
  },
};
