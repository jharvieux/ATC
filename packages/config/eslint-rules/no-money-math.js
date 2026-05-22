"use strict";

// §14.0.4 — ESLint rule: no-money-math
//
// Flags patterns that combine _cents identifiers with unsafe operations:
//   1. Number(_cents_var) — drops the integer bigint constraint
//   2. parseFloat(_cents_var or _amount_var) — same
//   3. _cents_var * _cents_var — multiplying two cent amounts (wrong units)
//   4. _cents_var * <numeric literal> — should use multiplyRate() instead
//
// These patterns are the §14.0.4 "code-review reflex made automated."

function hasCentsOrAmount(name) {
  return typeof name === "string" && (name.includes("_cents") || name.includes("_amount"));
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

      // _cents * _cents  OR  _cents * <literal>
      BinaryExpression(node) {
        if (node.operator !== "*") return;

        const leftName = getNodeName(node.left);
        const rightName = getNodeName(node.right);
        const leftIsCents = leftName && hasCentsOrAmount(leftName);
        const rightIsCents = rightName && hasCentsOrAmount(rightName);

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
