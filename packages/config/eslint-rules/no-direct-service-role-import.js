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

// Full path suffixes for allowed callers. Using path suffixes (not bare
// filenames) avoids false positives if a future file happens to share a name.
const ALLOWED_PATH_SUFFIXES = [
  "/lib/db/tenant-client.ts",
  "/lib/db/platform-admin-client.ts",
  // Middleware tenant resolver: runs before any user context exists, so
  // service-role is the only viable client. See BP04 / spec §1.4.
  "/lib/tenancy/resolve-tenant.ts",
  // Stripe webhook handler: operates before any user session; service-role
  // required for the idempotency insert into stripe_webhook_events. §7.9a.
  "/lib/stripe/webhook-handler.ts",
  // Inngest reconciliation job: background job running outside any user
  // session; service-role required to scan stripe_webhook_events. §7.9a.
  "/inngest/stripe-webhook-incomplete-reconcile.ts",
];

function endsWithAllowed(filename) {
  const normalized = filename.replace(/\\/g, "/");
  return ALLOWED_PATH_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
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
