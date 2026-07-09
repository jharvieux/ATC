// Flat config — replaces .eslintrc.json on Next 16 (`next lint` removed).
// Scope mirrors apps/main: atc/* rules apply to src/ only; test/ excluded.

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
      "*.config.mjs",
      "*.config.js",
      "*.config.ts",
    ],
  },
  ...nextCoreWebVitals,
  {
    // D-098 — see apps/main/eslint.config.mjs for the full rationale.
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
      "atc/no-unchecked-supabase-mutation": "error",
      // Guard-parity with apps/main (#1613 item 4): block the main-app
      // service-role env name from leaking into rag, and force ad-hoc
      // createClient through the getRagDb() factory.
      "atc/no-direct-service-role-env-import": "error",
      "atc/no-inline-supabase-client": "error",
      // Secret-shaped NEXT_PUBLIC_* env vars ship to the client bundle (#1637).
      "atc/no-secret-shaped-public-env": "error",
    },
  },
  ...sonarjsConfig,
];
