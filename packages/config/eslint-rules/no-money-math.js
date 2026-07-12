"use strict";

// §14.0.4 — ESLint rule: no-money-math
//
// Flags patterns that combine _cents identifiers with unsafe operations:
//   1. Number(_cents_var) — drops the integer bigint constraint
//   2. parseFloat(_cents_var or _amount_var) — same
//   3. _cents_var * _cents_var — multiplying two cent amounts (wrong units)
//   4. _cents_var * <numeric literal> — should use multiplyRate() instead
//   5. _cents_var / 100 — display formatting bypass; use fromCents() (#1606)
//
// These patterns are the §14.0.4 "code-review reflex made automated."

// Matches the *_cents/_amount naming convention plus the bare "cents"/
// "amount" identifiers that convention slips past (#1779) — e.g. a
// destructured or renamed param like `function f(cents: number)` has no
// underscore for the substring check to catch.
function hasCentsOrAmount(name) {
  if (typeof name !== "string") return false;
  if (name.includes("_cents") || name.includes("_amount")) return true;
  const lower = name.toLowerCase();
  return lower === "cents" || lower === "amount";
}

function getNodeName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && node.property.type === "Identifier")
    return node.property.name;
  return null;
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow unsafe arithmetic on _cents and _amount identifiers (§14.0.4).",
      category: "Money Safety",
      recommended: true,
    },
    schema: [],
    messages: {
      noNumberCents:
        "Do not pass a _cents variable to Number(). Use the money utility module instead.",
      noParseFloatCents:
        "Do not pass a _cents or _amount variable to parseFloat(). Use fromCents() for display only.",
      noCentsCents:
        "Do not multiply two _cents values together — this produces incorrect units. Use multiplyRate().",
      noCentsLiteral:
        "Do not multiply a _cents value by a numeric literal. Use multiplyRate(cents, rate) instead.",
      noCentsDivDisplay:
        "Do not divide a _cents value by 100 for display. Use fromCents(cents) — manual /100 loses the integer-cent invariant and rounds inconsistently (#1606).",
    },
  },

  create(context) {
    return {
      // Number(_cents_var)
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "Number" &&
          node.arguments.length === 1
        ) {
          const argName = getNodeName(node.arguments[0]);
          if (argName && hasCentsOrAmount(argName)) {
            context.report({ node, messageId: "noNumberCents" });
          }
        }

        // parseFloat(_cents_var or _amount_var)
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "parseFloat" &&
          node.arguments.length === 1
        ) {
          const argName = getNodeName(node.arguments[0]);
          if (argName && hasCentsOrAmount(argName)) {
            context.report({ node, messageId: "noParseFloatCents" });
          }
        }
      },

      // _cents * _cents  OR  _cents * <literal>  OR  _cents / 100
      BinaryExpression(node) {
        if (node.operator !== "*" && node.operator !== "/") return;

        const leftName = getNodeName(node.left);
        const rightName = getNodeName(node.right);
        const leftIsCents = leftName && hasCentsOrAmount(leftName);
        const rightIsCents = rightName && hasCentsOrAmount(rightName);

        // _cents / 100 — display formatting bypass (#1606).
        if (node.operator === "/") {
          if (leftIsCents && node.right.type === "Literal" && node.right.value === 100) {
            context.report({ node, messageId: "noCentsDivDisplay" });
          }
          return;
        }

        if (leftIsCents && rightIsCents) {
          context.report({ node, messageId: "noCentsCents" });
          return;
        }

        // _cents * numeric literal (not 1n — 1n is used for type conversions)
        if (leftIsCents && node.right.type === "Literal" && node.right.value !== 1) {
          context.report({ node, messageId: "noCentsLiteral" });
        }
        if (rightIsCents && node.left.type === "Literal" && node.left.value !== 1) {
          context.report({ node, messageId: "noCentsLiteral" });
        }
      },
    };
  },
};
