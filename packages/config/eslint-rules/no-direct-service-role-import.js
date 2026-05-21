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

const ALLOWED_FILES = [
  "tenant-client.ts",
  "platform-admin-client.ts",
];

function endsWithAllowed(filename) {
  return ALLOWED_FILES.some((allowed) =>
    filename.replace(/\\/g, "/").endsWith(`/lib/db/${allowed}`),
  );
}

function isServiceRoleClientImport(source) {
  if (!source) return false;
  // Match any path whose final segment is service-role-client(.ts)? — covers
  // ./service-role-client, ./db/service-role-client, ../../lib/db/service-role-client,
  // and @/lib/db/service-role-client equally.
  return /(?:^|[\\/])service-role-client(?:\.ts)?$/.test(source);
}

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
        "Importing service-role-client is not allowed here. Use tenantClient(ctx) or withPlatformAdminAudit(...) instead (spec §5.4.4).",
    },
  },
  create(context) {
    const filename = context.getFilename
      ? context.getFilename()
      : context.filename;
    if (endsWithAllowed(filename)) {
      return {};
    }
    return {
      ImportDeclaration(node) {
        if (isServiceRoleClientImport(node.source.value)) {
          context.report({ node, messageId: "forbidden" });
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
          context.report({ node, messageId: "forbidden" });
        }
      },
    };
  },
};
