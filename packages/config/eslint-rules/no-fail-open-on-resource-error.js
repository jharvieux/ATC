"use strict";

// D-091 — ESLint rule: no-fail-open-on-resource-error (OPT-IN, off by default)
//
// Flags `catch` blocks that return a permissive value (`{ allowed: true }`,
// `{ ok: true }`) without re-throwing or surfacing the error. Failing open
// at the worst moment (when an enforcement layer is unreachable) is the worst
// possible failure mode.
//
// Heuristic — high false-positive risk because some catches are intentional
// (e.g., the "all-checks-passed" branch returns the same shape as the catch).
// Shipped at `off` by default; operator flips to `warn` after a one-pass
// audit of existing fail-open sites.
//
// Pattern that fires:
//   try { ... } catch (err) {
//     return { allowed: true };   ← problematic
//   }
//
// Pattern that doesn't fire:
//   try { ... } catch (err) {
//     return { allowed: false };
//     // or: throw err;
//     // or: return new Response(..., { status: 500 });
//   }

function findReturnedObjectKeys(node) {
  // Walk a BlockStatement and collect any literal `{...}` returned from it.
  // Returns an array of arrays of property-name strings.
  const results = [];
  for (const stmt of node.body) {
    if (stmt.type !== "ReturnStatement" || !stmt.argument) continue;
    if (stmt.argument.type !== "ObjectExpression") continue;
    const keys = stmt.argument.properties
      .filter((p) => p.type === "Property" && p.key.type === "Identifier")
      .map((p) => ({ key: p.key.name, value: p.value }));
    results.push(keys);
  }
  return results;
}

function isFailOpenReturn(returnedKeys) {
  // Heuristic: object literal with one of these key/value combinations.
  for (const { key, value } of returnedKeys) {
    if (
      (key === "allowed" || key === "ok") &&
      value.type === "Literal" &&
      value.value === true
    ) {
      return true;
    }
  }
  return false;
}

module.exports = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Flag catch blocks that return permissive values (allowed: true, ok: true) when an enforcement layer fails — fail-closed instead.",
      category: "Security",
      recommended: false,
    },
    schema: [],
    messages: {
      failOpen:
        "Catch block returns a permissive value when the enforcement layer fails. This is fail-open behavior. Either re-throw, log + return restrictive, or document why permission is correct here (D-091).",
    },
  },
  create(context) {
    return {
      CatchClause(node) {
        if (!node.body || node.body.type !== "BlockStatement") return;
        const returns = findReturnedObjectKeys(node.body);
        for (const ret of returns) {
          if (isFailOpenReturn(ret)) {
            context.report({ node, messageId: "failOpen" });
            return; // one report per catch is enough
          }
        }
      },
    };
  },
};
