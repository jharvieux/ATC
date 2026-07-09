"use strict";

// Shift-left guard (#1613 item 2, follow-up to #1607 audit-writer consolidation).
//
// Forbids writing to the `audit_log` table directly — `.from("audit_log")`
// chained to a mutating method (`.insert` / `.update` / `.upsert` / `.delete`).
// Every audit write must go through the consolidated writer in lib/audit/ so
// that actor/tenant/changes shaping and the append-only invariant stay in one
// place. #1607 consolidated the writers; before that, six direct writers
// (including the security-monitoring crons) each shaped the row by hand.
//
// READS are untouched — `.from("audit_log").select(...)` is legitimate anywhere
// (the dashboard route and the permission/RLS-bypass monitors all read it).
// Only mutations are flagged.
//
// Allowed writers (the ONLY files permitted to mutate audit_log):
//   - src/lib/audit/*                       — the canonical writer
//   - src/lib/db/platform-admin-client.ts   — platform-admin audit write path
//   - src/inngest/audit-log-retention-purge.ts — retention DELETE (purge job)

const MUTATING_METHODS = new Set(["insert", "update", "upsert", "delete"]);

const ALLOWED_PATH_SUFFIXES = [
  "/lib/db/platform-admin-client.ts",
  "/inngest/audit-log-retention-purge.ts",
];

function isAllowedFile(filename) {
  const normalized = filename.replace(/\\/g, "/");
  if (normalized.includes("/lib/audit/")) return true;
  return ALLOWED_PATH_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct writes to the audit_log table outside lib/audit/ — route audit writes through the consolidated writer (#1607).",
      category: "Security",
      recommended: true,
    },
    schema: [],
    messages: {
      directWrite:
        "Direct {{ method }} on audit_log is forbidden. Route audit writes through lib/audit/ (the consolidated writer) — reads are fine, writes must be centralized.",
    },
  },
  create(context) {
    const filename = context.getFilename ? context.getFilename() : context.filename;
    if (isAllowedFile(filename)) return {};

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "from"
        ) {
          return;
        }
        const arg = node.arguments[0];
        if (!arg || arg.type !== "Literal" || arg.value !== "audit_log") return;

        // The mutating method is called directly on the .from() result:
        //   .from("audit_log").insert(...)  /  .delete().lt(...)
        const parent = node.parent;
        if (
          parent &&
          parent.type === "MemberExpression" &&
          parent.property.type === "Identifier" &&
          MUTATING_METHODS.has(parent.property.name)
        ) {
          context.report({
            node: parent.property,
            messageId: "directWrite",
            data: { method: parent.property.name },
          });
        }
      },
    };
  },
};
