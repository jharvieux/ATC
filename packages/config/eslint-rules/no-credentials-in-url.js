"use strict";

// D-091 — ESLint rule: no-credentials-in-url
//
// Flags template literals containing `?token=`, `?api_key=`, `?secret=`,
// `?password=`, `?auth_key=` (case-insensitive) when used in a `fetch()` call.
//
// External credentials in URLs leak to: proxy logs, CDN logs, APM traces,
// browser history, server access logs, Node.js fetch TypeError messages.
// Use `Authorization: Bearer ...` headers instead.
//
// Heuristic: any CallExpression to `fetch` (or any callee named `fetch`)
// whose first argument is a TemplateLiteral containing a suspicious query
// parameter.

const CREDENTIAL_QUERY_PARAM_RE =
  /\?(?:[^&"`\s]*&)?(?:token|api[_-]?key|secret|password|auth[_-]?key)=/i;

function looksLikeFetch(callee) {
  if (callee.type === "Identifier") return callee.name === "fetch";
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
    return callee.property.name === "fetch";
  }
  return false;
}

function templateLiteralText(node) {
  if (!node || node.type !== "TemplateLiteral") return null;
  // Concatenate the static parts; we just need to check whether the static
  // text contains the suspicious query parameter — the substituted values
  // are typically the credential itself.
  return node.quasis.map((q) => q.value.cooked).join("");
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow embedding credentials (token, api_key, secret, password, auth_key) in URL query strings — use Authorization headers instead.",
      category: "Security",
      recommended: true,
    },
    schema: [],
    messages: {
      credentialInUrl:
        'Credential ({{param}}) in URL query string leaks to proxy/CDN/APM logs and Node\'s fetch error messages. Move to an Authorization: Bearer header.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!looksLikeFetch(node.callee)) return;
        const firstArg = node.arguments[0];
        const text = templateLiteralText(firstArg);
        if (!text) return;
        const match = text.match(CREDENTIAL_QUERY_PARAM_RE);
        if (!match) return;
        // Extract the offending parameter name for the message.
        const paramMatch = match[0].match(/[?&](\w+)=/);
        context.report({
          node: firstArg,
          messageId: "credentialInUrl",
          data: { param: paramMatch ? paramMatch[1] : "credential" },
        });
      },
    };
  },
};
