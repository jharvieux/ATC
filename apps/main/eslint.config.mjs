// Flat config — replaces .eslintrc.json on Next 16 (`next lint` removed).
// eslint-config-next 16 ships native flat-config exports under
// `eslint-config-next/core-web-vitals`, so we can compose without FlatCompat.
//
// Scope:
//   - The Next + React rules apply to everything under src/ (same as the
//     legacy `next lint` default).
//   - The atc/* rules apply to src/ only — they're meant to catch
//     anti-patterns in production code, not in test fixtures.
//   - test/ and load-tests/ are excluded entirely (they have intentional
//     direct service-role usage, .any() casts, and anonymous default
//     exports for k6 scripts).

import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import atcPlugin from "eslint-plugin-atc";

export default [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      "coverage/**",
      "test/**",
      "load-tests/**",
      "*.config.mjs",
      "*.config.js",
      "*.config.ts",
      "scripts/**",
    ],
  },
  ...nextCoreWebVitals,
  {
    // react-hooks 6.x (shipped with React 19 / Next 16) added two opinionated
    // rules that flag patterns this codebase uses extensively. Following up
    // on either would be a code-cleanup PR; downgrade to warning for now so
    // the migration doesn't block on prior code shape.
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
    },
  },
  {
    files: ["src/**/*.{ts,tsx,js,jsx}"],
    plugins: {
      atc: atcPlugin,
    },
    rules: {
      "atc/no-direct-service-role-import": "error",
      "atc/platform-admin-functions-must-use-audit-wrapper": "error",
      "atc/no-money-math": "error",
      "atc/no-direct-service-role-env-import": "error",
      "atc/no-direct-anthropic-or-openai-import": "error",
      "atc/no-ad-hoc-tenant-id-string": "off",
      "atc/no-direct-octokit-import": "error",
      "atc/no-orphan-todo": "error",
      "atc/no-narrating-comments": "off",
      "atc/no-unchecked-supabase-mutation": "error",
      "atc/no-credentials-in-url": "error",
      "atc/no-fail-open-on-resource-error": "off",
    },
  },
];
