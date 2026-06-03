// Shared eslint-plugin-sonarjs config — consumed by apps/main + apps/rag flat
// configs (and available to any future scripts/ lint pass).
//
// We do NOT use sonarjs.configs.recommended (269 rules). Under our
// `eslint . --max-warnings=0` lint, every enabled rule is fix-to-green, so the
// recommended set's high-count style/complexity rules would either flood the
// gate or fight our own conventions. Measured on the tree (2026-06-03) the
// recommended set flagged 346 issues; the bulk were rules we deliberately omit:
//   - cognitive-complexity / no-nested-conditional — style/complexity, ~170 hits
//   - todo-tag — conflicts with atc/no-orphan-todo (our TODO policy)
//   - void-use — conflicts with D-091's sanctioned `void asyncFn()` + allow-void-async
//   - slow-regex — 36 "make sure this regex is safe" HOTSPOTS, ~all benign;
//     handled as a focused security review (issue #68), not a blanket gate.
// What remains below is the genuine-bug subset: it catches the failure modes
// (dead code, duplicated/identical logic, malformed regex) without noise.
const sonarjs = require("eslint-plugin-sonarjs");

module.exports = [
  {
    files: ["src/**/*.{ts,tsx,js,jsx}"],
    plugins: { sonarjs },
    rules: {
      "sonarjs/no-unenclosed-multiline-block": "error",
      "sonarjs/no-duplicated-branches": "error",
      "sonarjs/no-identical-functions": "error",
      "sonarjs/no-redundant-jump": "error",
      "sonarjs/prefer-single-boolean-return": "error",
      "sonarjs/no-dead-store": "error",
      "sonarjs/no-redundant-assignments": "error",
      "sonarjs/duplicates-in-character-class": "error",
      "sonarjs/single-character-alternation": "error",
    },
  },
];
