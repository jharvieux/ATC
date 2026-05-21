"use strict";

// Spec ref: §5.4.4, §5.4.8 ("Calling convention")
//
// Flags any exported function whose name matches /^platformAdmin[A-Z]/ but
// whose body does not contain a call to `withPlatformAdminAudit`. Every
// platform-admin operation MUST be wrapped — that is the single contract
// that produces the audit row §26.3a.3 requires.
//
// Detection is intentionally lexical (not semantic): the rule fires on
// the syntactic absence of `withPlatformAdminAudit(`. Aliases or indirect
// calls would still produce an audit row at runtime but would slip past
// this rule. That tradeoff is acceptable — the rule is a hint to push
// engineers toward the canonical name; the audit row is the real source
// of truth.

function containsAuditWrapperCall(node) {
  let found = false;
  const visit = (n) => {
    if (!n || typeof n !== "object" || found) return;
    if (Array.isArray(n)) {
      for (const child of n) visit(child);
      return;
    }
    if (
      n.type === "CallExpression" &&
      n.callee &&
      n.callee.type === "Identifier" &&
      n.callee.name === "withPlatformAdminAudit"
    ) {
      found = true;
      return;
    }
    for (const key of Object.keys(n)) {
      if (key === "parent") continue;
      const child = n[key];
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(node);
  return found;
}

function isPlatformAdminName(name) {
  return typeof name === "string" && /^platformAdmin[A-Z]/.test(name);
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Exported platformAdmin* functions must call withPlatformAdminAudit in their body (spec §5.4.8)",
    },
    schema: [],
    messages: {
      missingWrapper:
        "Function '{{name}}' looks like a platform-admin operation but does not call withPlatformAdminAudit. Wrap the body per spec §5.4.8.",
    },
  },
  create(context) {
    function check(funcNode, name) {
      if (!isPlatformAdminName(name)) return;
      if (!containsAuditWrapperCall(funcNode.body)) {
        context.report({
          node: funcNode,
          messageId: "missingWrapper",
          data: { name },
        });
      }
    }

    return {
      // export function platformAdminFoo() { ... }
      ExportNamedDeclaration(node) {
        if (
          node.declaration &&
          node.declaration.type === "FunctionDeclaration" &&
          node.declaration.id
        ) {
          check(node.declaration, node.declaration.id.name);
        }
        if (
          node.declaration &&
          node.declaration.type === "VariableDeclaration"
        ) {
          for (const decl of node.declaration.declarations) {
            if (
              decl.id &&
              decl.id.type === "Identifier" &&
              decl.init &&
              (decl.init.type === "ArrowFunctionExpression" ||
                decl.init.type === "FunctionExpression")
            ) {
              check(decl.init, decl.id.name);
            }
          }
        }
      },
      // export default function platformAdminFoo() { ... }
      ExportDefaultDeclaration(node) {
        if (
          node.declaration &&
          node.declaration.type === "FunctionDeclaration" &&
          node.declaration.id
        ) {
          check(node.declaration, node.declaration.id.name);
        }
      },
    };
  },
};
