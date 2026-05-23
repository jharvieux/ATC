"use strict";

// §26.3a — Heuristic: flag function signatures of the shape
//   function X(tenant_id: string, ...)
// that ALSO issue a database query inside the body.
//
// The replacement is `function X(ctx: TenantContext, ...)` using
// tenantClient(ctx) — that way the TenantContext provenance is preserved
// through the call stack rather than reduced to a bare string.
//
// Heuristic, NOT exhaustive — false positives are expected. Silence them
// with `// eslint-disable-next-line atc/no-ad-hoc-tenant-id-string` AND
// add an entry to docs/exceptions-service-role.md (date, file, reason,
// reviewer). Quarterly review by platform-super-admin per §26.11.
//
// BP26 ships this rule at "warn" severity initially; a follow-on PR runs
// the codebase-wide exception audit and flips to "error". See MEMORY D-059.

// AST keys to recurse into. Avoids `parent` and other circular refs that
// would blow the stack. Conservative — we don't need exhaustive coverage,
// only enough to find a likely `.from(...)` / `.rpc(...)` call.
const RECURSE_KEYS = [
  "body",
  "consequent",
  "alternate",
  "block",
  "handler",
  "finalizer",
  "expression",
  "left",
  "right",
  "argument",
  "arguments",
  "callee",
  "object",
  "property",
  "init",
  "declarations",
  "elements",
  "properties",
  "value",
  "test",
  "cases",
];

function hasDbQuery(bodyNode) {
  let found = false;
  const seen = new WeakSet();
  function walk(node) {
    if (!node || typeof node !== "object" || found) return;
    if (seen.has(node)) return;
    seen.add(node);
    if (node.type === "CallExpression" && node.callee?.type === "MemberExpression") {
      const propName = node.callee.property?.name;
      if (propName === "from" || propName === "rpc") {
        found = true;
        return;
      }
    }
    for (const key of RECURSE_KEYS) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  }
  walk(bodyNode);
  return found;
}

function paramIsTenantIdString(param) {
  if (!param) return false;
  // function foo(tenant_id: string, ...)
  if (
    param.type === "Identifier" &&
    param.name === "tenant_id" &&
    param.typeAnnotation?.typeAnnotation?.type === "TSStringKeyword"
  ) {
    return true;
  }
  // Destructured object: function foo({ tenant_id }: { tenant_id: string })
  if (param.type === "ObjectPattern" && param.typeAnnotation) {
    const anno = param.typeAnnotation.typeAnnotation;
    if (anno?.type === "TSTypeLiteral") {
      for (const member of anno.members ?? []) {
        if (
          member.type === "TSPropertySignature" &&
          member.key?.name === "tenant_id" &&
          member.typeAnnotation?.typeAnnotation?.type === "TSStringKeyword"
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function check(context, node, body) {
  for (const param of node.params ?? []) {
    if (paramIsTenantIdString(param) && body && hasDbQuery(body)) {
      context.report({ node: param, messageId: "ad_hoc" });
      return;
    }
  }
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow function signatures taking tenant_id as a string when the body issues DB queries (spec §26.3a — prefer TenantContext)",
    },
    schema: [],
    messages: {
      ad_hoc:
        "Pass a TenantContext (ctx: TenantContext) instead of a bare tenant_id string when the function issues DB queries. Use tenantClient(ctx). If this is a legitimate exception, add to docs/exceptions-service-role.md.",
    },
  },
  create(context) {
    return {
      FunctionDeclaration(node) {
        check(context, node, node.body);
      },
      FunctionExpression(node) {
        check(context, node, node.body);
      },
      ArrowFunctionExpression(node) {
        check(context, node, node.body);
      },
    };
  },
};
