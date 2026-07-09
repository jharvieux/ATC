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
  {
    // Grandfathered ad-hoc createClient sites (block-new, not rewrite-existing).
    // These 12 files build clients directly instead of getRagDb(); migrating
    // them is a runtime change (singleton vs fresh client, header/auth wiring
    // differences) tracked in a follow-up issue. New files are NOT exempt — the
    // rule fires everywhere else so the count can only shrink.
    files: [
      "src/app/api/platform-settings-events/route.ts",
      "src/app/api/feedback/route.ts",
      "src/app/api/tenant-events/route.ts",
      "src/inngest/openai-embedding-stale-alert.ts",
      "src/inngest/openai-embedding-reconcile.ts",
      "src/inngest/openai-embedding-flush.ts",
      "src/inngest/promo-state-drift-alert.ts",
      "src/inngest/promo-state-reconcile.ts",
      "src/inngest/retrieval-log-aggregate.ts",
      "src/inngest/tenant-registry-reconcile.ts",
      "src/inngest/platform-settings-reconcile.ts",
      "src/lib/auth/verify-service-jwt.ts",
    ],
    rules: {
      "atc/no-inline-supabase-client": "off",
    },
  },
  ...sonarjsConfig,
];
