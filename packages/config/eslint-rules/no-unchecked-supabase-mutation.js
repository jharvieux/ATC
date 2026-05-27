"use strict";

// D-091 slop-reduction — ESLint rule: no-unchecked-supabase-mutation
//
// Flags Supabase mutations (`.update()`, `.insert()`, `.delete()`, `.upsert()`)
// where the awaited result is discarded as an expression statement. Supabase
// JS v2 returns `{ data, error }` and does NOT throw — discarding the result
// silently swallows every DB error.
//
// Pattern that fires:
//   await db.from("x").update({...}).eq("id", id);    ← discarded
//   await client.from("x").insert(rows);              ← discarded
//
// Pattern that DOESN'T fire:
//   const { error } = await db.from("x").update(...).eq(...);
//   const result = await db.from("x").update(...).eq(...);
//   return db.from("x").update(...).eq(...);          ← caller handles it
//
// Heuristic: walks the AST and looks for an ExpressionStatement whose
// expression is an AwaitExpression whose chain includes a method call to
// one of MUTATING_METHODS on a `.from(...)` call.

const MUTATING_METHODS = new Set(["update", "insert", "delete", "upsert"]);

function hasMutationCall(node) {
  // Walk a chain like x.from(...).update(...).eq(...) — return true if any
  // call in the chain is to a mutating method on the result of .from(...).
  let current = node;
  let sawFrom = false;
  let sawMutation = false;
  while (
    current &&
    current.type === "CallExpression" &&
    current.callee.type === "MemberExpression"
  ) {
    const methodName = current.callee.property.name;
    if (methodName === "from") sawFrom = true;
    if (MUTATING_METHODS.has(methodName)) sawMutation = true;
    current = current.callee.object;
  }
  return sawFrom && sawMutation;
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow discarding the result of a Supabase mutation. Supabase JS v2 doesn't throw — silent errors are hidden.",
      category: "Correctness",
      recommended: true,
    },
    schema: [],
    messages: {
      uncheckedMutation:
        "Supabase mutation result discarded. Destructure {{ data, error }} and handle errors — Supabase JS v2 does NOT throw on DB errors.",
    },
  },
  create(context) {
    return {
      ExpressionStatement(node) {
        const expr = node.expression;
        if (!expr || expr.type !== "AwaitExpression") return;
        const inner = expr.argument;
        if (!inner || inner.type !== "CallExpression") return;
        if (!hasMutationCall(inner)) return;
        context.report({
          node,
          messageId: "uncheckedMutation",
        });
      },
    };
  },
};
