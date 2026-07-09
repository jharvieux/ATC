"use strict";

// Shift-left guard (#1637) — secret-shaped NEXT_PUBLIC_* env var lint.
//
// Any `NEXT_PUBLIC_*` value is inlined into the CLIENT bundle by Next.js
// convention, so it ships to every browser. A NEXT_PUBLIC_ name that looks like
// a credential (…KEY / …SECRET / …TOKEN / …SERVICE / …PRIVATE) is almost always
// a mistake — a real secret about to be published. This flags the reference at
// the name, regardless of the value (a naming-convention check, no value read).
//
// Allowlist: the two names that ARE meant to be public — the Stripe publishable
// key and the Supabase anon key are client credentials by design. A new
// legitimately-public secret-shaped name adds itself here (with a reason).

const SUSPICIOUS_RE = /(KEY|SECRET|TOKEN|SERVICE|PRIVATE)/i;

const PUBLIC_BY_DESIGN = new Set([
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
]);

function isFlagged(name) {
  return (
    typeof name === "string" &&
    name.startsWith("NEXT_PUBLIC_") &&
    !PUBLIC_BY_DESIGN.has(name) &&
    SUSPICIOUS_RE.test(name.slice("NEXT_PUBLIC_".length))
  );
}

// process.env.<NAME> → dotted member access.
function dottedEnvName(node) {
  if (
    node.object &&
    node.object.type === "MemberExpression" &&
    node.object.object &&
    node.object.object.type === "Identifier" &&
    node.object.object.name === "process" &&
    node.object.property &&
    node.object.property.name === "env" &&
    node.property &&
    node.property.type === "Identifier"
  ) {
    return node.property.name;
  }
  return null;
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow secret-shaped NEXT_PUBLIC_* env vars — a NEXT_PUBLIC_ prefix ships the value to the client bundle (#1637).",
      category: "Security",
      recommended: true,
    },
    schema: [],
    messages: {
      secretShaped:
        "{{ name }} has a NEXT_PUBLIC_ prefix (client-bundled) but a credential-shaped name. If it is a real secret, drop NEXT_PUBLIC_; if it is genuinely public, add it to the rule's allowlist.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        const name = dottedEnvName(node);
        if (name && isFlagged(name)) {
          context.report({ node, messageId: "secretShaped", data: { name } });
        }
      },
      // process.env["NEXT_PUBLIC_…"] → computed bracket access.
      Literal(node) {
        if (typeof node.value !== "string" || !isFlagged(node.value)) return;
        const parent = node.parent;
        if (
          parent &&
          parent.type === "MemberExpression" &&
          parent.computed === true &&
          parent.object &&
          parent.object.type === "MemberExpression" &&
          parent.object.object &&
          parent.object.object.type === "Identifier" &&
          parent.object.object.name === "process" &&
          parent.object.property &&
          parent.object.property.name === "env"
        ) {
          context.report({ node: parent, messageId: "secretShaped", data: { name: node.value } });
        }
      },
    };
  },
};
