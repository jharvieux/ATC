"use strict";

// §26.3a — Forbids importing SUPABASE_SERVICE_ROLE_KEY (or reading it
// from process.env) outside the two factory files that are allowed to
// construct service-role clients. The env var is read ONCE, in those
// factories. Reading it anywhere else is the same threat as importing
// the service-role client directly.
//
// Allowed file paths:
//   - src/lib/db/service-role-client.ts (the canonical reader)
//   - src/lib/env.ts (boot-time validation)

const ALLOWED_PATH_SUFFIXES = [
  "/lib/db/service-role-client.ts",
  "/lib/env.ts",
  // BP17 — CCPA export uses Supabase Storage REST directly (no JS client
  // wrapper for this endpoint shape). The file is already on the
  // service-role-import allowlist; the env read here mirrors that exception.
  "/inngest/user-data-export-build.ts",
  // BP19 grandfathered entries removed: the 5 group/invitation + auth-
  // callback files now route through createServiceRoleClient() and live
  // on the no-direct-service-role-import allowlist instead.
];

function endsWithAllowed(filename) {
  const normalized = filename.replace(/\\/g, "/");
  return ALLOWED_PATH_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading SUPABASE_SERVICE_ROLE_KEY outside the service-role-client factory or env.ts (spec §26.3a)",
    },
    schema: [],
    messages: {
      forbidden:
        "Reading SUPABASE_SERVICE_ROLE_KEY here is forbidden. The env var is consumed once in service-role-client.ts; use the factory.",
    },
  },
  create(context) {
    const filename = context.getFilename ? context.getFilename() : context.filename;
    if (endsWithAllowed(filename)) return {};

    return {
      MemberExpression(node) {
        // process.env.SUPABASE_SERVICE_ROLE_KEY
        if (
          node.object &&
          node.object.type === "MemberExpression" &&
          node.object.object &&
          node.object.object.type === "Identifier" &&
          node.object.object.name === "process" &&
          node.object.property &&
          node.object.property.type === "Identifier" &&
          node.object.property.name === "env" &&
          node.property &&
          node.property.type === "Identifier" &&
          node.property.name === "SUPABASE_SERVICE_ROLE_KEY"
        ) {
          context.report({ node, messageId: "forbidden" });
        }
      },
      Literal(node) {
        // Bracket access like process.env['SUPABASE_SERVICE_ROLE_KEY']
        if (
          node.value === "SUPABASE_SERVICE_ROLE_KEY" &&
          node.parent &&
          node.parent.type === "MemberExpression" &&
          node.parent.computed === true
        ) {
          const obj = node.parent.object;
          if (
            obj &&
            obj.type === "MemberExpression" &&
            obj.object &&
            obj.object.type === "Identifier" &&
            obj.object.name === "process" &&
            obj.property &&
            obj.property.type === "Identifier" &&
            obj.property.name === "env"
          ) {
            context.report({ node: node.parent, messageId: "forbidden" });
          }
        }
      },
    };
  },
};
