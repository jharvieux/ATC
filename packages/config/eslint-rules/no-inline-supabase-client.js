"use strict";

// Shift-left guard (#1613 item 4) — client-factory discipline for apps/rag.
//
// apps/rag has a canonical service-role factory (src/lib/db/supabase.ts →
// getRagDb()). Every ad-hoc `createClient` call duplicates the url/key wiring
// and can pick the wrong key or skip the factory's auth options — the exact
// drift that let a main-app env name leak in (#1595 review). The prior 12
// ad-hoc importers were migrated onto the factory in #1708/#1729 (#1772);
// this rule now enforces repo-wide with no grandfathered files.
//
// This rule forbids importing the `createClient` VALUE from @supabase/supabase-js
// outside the factory. Importing the `SupabaseClient` TYPE stays allowed (type
// imports don't construct a client). apps/main has its own service-role
// discipline (no-direct-service-role-import + the allowlist); this rule is the
// rag-local equivalent the parity gap needed.
//
// Allowed to call createClient: src/lib/db/supabase.ts (the factory).

const ALLOWED_PATH_SUFFIXES = ["/lib/db/supabase.ts"];

function isAllowedFile(filename) {
  const normalized = filename.replace(/\\/g, "/");
  return ALLOWED_PATH_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing createClient from @supabase/supabase-js outside the db factory — use getRagDb() (#1613).",
      category: "Security",
      recommended: true,
    },
    schema: [],
    messages: {
      inlineClient:
        "Do not construct a Supabase client with createClient here. Import getRagDb from @/lib/db/supabase — ad-hoc clients drift on key/auth wiring (#1595).",
    },
  },
  create(context) {
    const filename = context.getFilename ? context.getFilename() : context.filename;
    if (isAllowedFile(filename)) return {};

    return {
      ImportDeclaration(node) {
        if (node.source.value !== "@supabase/supabase-js") return;
        for (const spec of node.specifiers) {
          if (
            spec.type === "ImportSpecifier" &&
            spec.imported.name === "createClient" &&
            spec.importKind !== "type" &&
            node.importKind !== "type"
          ) {
            context.report({ node: spec, messageId: "inlineClient" });
          }
        }
      },
    };
  },
};
