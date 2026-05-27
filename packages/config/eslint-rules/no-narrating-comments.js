"use strict";

// D-091 slop-reduction — ESLint rule: no-narrating-comments
//
// Flags single-line `//` comments that appear to describe what the next
// line of code literally does. Heuristic, deliberately conservative:
// only flags short comments (≤ 6 words) starting with a known narrating
// verb pattern.
//
// Why: comments should explain WHY, not WHAT. "// fetch user" above an
// `await fetchUser()` call is pure slop. A future reader gets nothing
// from the comment that they don't get from the code.
//
// Safe cases NOT flagged:
//   - JSDoc / block comments (`/** ... */`).
//   - Spec / decision references (`§...`, `D-...`, `bp\d+`).
//   - eslint-disable / ts-ignore directives.
//   - Comments longer than 6 words (likely carry actual content).
//   - Section dividers (`// ───── ...`).

// Verbs followed optionally by an article, then a single token.
// Conservative on purpose — better to miss slop than flag substance.
const NARRATING_RE =
  /^(loop|iterate|fetch|set|get|load|store|save|validate|verify|check|ensure|create|update|delete|remove|initialize|init|return|build|parse|compute|calculate|handle|process|read|write|apply|execute|invoke|call|trigger)(\s+(the|a|an|all|every|this|that|each|some|any))?\s+\w+\.?$/i;

// Patterns that look like markers/refs/directives, not narration.
const DIRECTIVE_RE =
  /^(eslint|ts-|prettier|@|§|#|D-\d|bp\d+|--|=|>|\s*$|---|\*)/i;

module.exports = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Flag short comments that narrate what the next line of code does instead of explaining why.",
      category: "Slop reduction",
      recommended: false,
    },
    schema: [],
    messages: {
      narrating:
        'Comment narrates what the next line does ("{{snippet}}"). Delete it or rewrite to explain WHY (a constraint, an invariant, a workaround).',
    },
  },
  create(context) {
    const sourceCode = context.getSourceCode();
    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          if (comment.type !== "Line") continue;
          const text = comment.value.trim();
          if (!text) continue;
          if (DIRECTIVE_RE.test(text)) continue;
          if (text.split(/\s+/).length > 6) continue;
          if (NARRATING_RE.test(text)) {
            context.report({
              node: comment,
              messageId: "narrating",
              data: { snippet: text.slice(0, 60) },
            });
          }
        }
      },
    };
  },
};
