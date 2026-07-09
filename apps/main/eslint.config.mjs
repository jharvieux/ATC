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
import sonarjsConfig from "@atc/config/sonarjs.js";

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
    // react-hooks 6.x (React 19 / Next 16) added two rules disabled here by
    // deliberate decision (D-098):
    //
    // - `react-hooks/set-state-in-effect` — fires on the standard client-side
    //   data-load pattern `useEffect(() => void fetchX(), [deps])` (33 sites
    //   across the codebase). React team's compliant alternatives are
    //   useSWR/TanStack-Query/Server-Components/`use()` — all of which are
    //   significant refactors. Cascading-rerender cost is negligible on the
    //   admin pages this pattern is used in.
    //
    // - `react-hooks/immutability` — flagged 4 setState calls inside `async
    //   function`s declared AFTER the useEffect that references them; appears
    //   to be a false positive in v6.0. Reassessment due when the rule
    //   stabilizes.
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
      // Shift-left guard batch (#1613): audit writes go through lib/audit/;
      // a single consolidated escapeHtml (canonical in lib/utils.ts).
      "atc/no-direct-audit-log-write": "error",
      "atc/no-local-escape-html": "error",
      // Secret-shaped NEXT_PUBLIC_* env vars ship to the client bundle (#1637).
      "atc/no-secret-shaped-public-env": "error",
    },
  },
  ...sonarjsConfig,
];
