// Flat config — replaces .eslintrc.json on Next 16 (`next lint` removed).
// Scope mirrors apps/main: atc/* rules apply to src/ only; test/ excluded.

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
    },
  },
];
