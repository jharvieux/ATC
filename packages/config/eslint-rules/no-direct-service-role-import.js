"use strict";

// Spec ref: §5.4.4
//
// Forbids importing from `src/lib/db/service-role-client.ts` outside of
// the two files that are allowed to construct a raw service-role client:
//   - src/lib/db/tenant-client.ts
//   - src/lib/db/platform-admin-client.ts
//
// Every other code path must use `tenantClient(ctx)` or
// `withPlatformAdminAudit(...)`. A raw service-role client bypasses RLS,
// so an unaudited import silently defeats tenant isolation.

// The allowlist DATA lives in ./service-role-allowlist.js so this rule stays
// pure logic. That file is a security boundary — see its header. Each entry is
// a full path suffix (not a bare filename) to avoid name-collision false positives.
const ALLOWED_PATH_SUFFIXES = require("./service-role-allowlist");

function endsWithAllowed(filename) {
  const normalized = filename.replace(/\\/g, "/");
  return ALLOWED_PATH_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

// Derive the path suffix a developer would add to ALLOWED_PATH_SUFFIXES
// to allowlist this file. Strips the workspace-prefix so the suggestion
// matches the existing entry style ("/app/api/foo/route.ts" rather than
// "/Users/.../apps/main/src/app/api/foo/route.ts").
function suggestAllowlistEntry(filename) {
  const normalized = filename.replace(/\\/g, "/");
  // Strip everything up to and including the workspace `src/` segment.
  const match = normalized.match(/\/apps\/(?:main|rag)\/src(\/.+)$/);
  if (match) return match[1];
  // Fallback: anything after the last "src/" in the path.
  const srcIdx = normalized.lastIndexOf("/src/");
  if (srcIdx >= 0) return normalized.slice(srcIdx + 4);
  return normalized;
}

function isServiceRoleClientImport(source) {
  if (!source) return false;
  // Match any path whose final segment is service-role-client(.ts)? — covers
  // ./service-role-client, ./db/service-role-client, ../../lib/db/service-role-client,
  // and @/lib/db/service-role-client equally.
  return /(?:^|[\\/])service-role-client(?:\.ts)?$/.test(source);
}

const ALLOWLIST_FILE =
  "packages/config/eslint-rules/service-role-allowlist.js";

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing service-role-client.ts outside tenant-client.ts and platform-admin-client.ts (spec §5.4.4)",
    },
    schema: [],
    messages: {
      forbidden:
        "Importing service-role-client is not allowed here. Use tenantClient(ctx) or withPlatformAdminAudit(...) instead (spec §5.4.4).\n" +
        "\n" +
        "If this route MUST use service-role (token-only auth, cross-tenant cron, etc.), add this path suffix to ALLOWED_PATH_SUFFIXES in {{ allowlistFile }}, with a // comment naming the spec section that justifies it:\n" +
        "    \"{{ suggestion }}\",\n",
    },
  },
  create(context) {
    const filename = context.getFilename
      ? context.getFilename()
      : context.filename;
    if (endsWithAllowed(filename)) {
      return {};
    }
    const suggestion = suggestAllowlistEntry(filename);
    return {
      ImportDeclaration(node) {
        if (isServiceRoleClientImport(node.source.value)) {
          context.report({
            node,
            messageId: "forbidden",
            data: { suggestion, allowlistFile: ALLOWLIST_FILE },
          });
        }
      },
      CallExpression(node) {
        // Dynamic import() and require()
        if (
          (node.callee.type === "Import" ||
            (node.callee.type === "Identifier" &&
              node.callee.name === "require")) &&
          node.arguments[0] &&
          node.arguments[0].type === "Literal" &&
          isServiceRoleClientImport(node.arguments[0].value)
        ) {
          context.report({
            node,
            messageId: "forbidden",
            data: { suggestion, allowlistFile: ALLOWLIST_FILE },
          });
        }
      },
    };
  },
};
