import { mergeConfig, configDefaults } from "vitest/config";
import base from "./vitest.config";

// Stryker-only vitest config. Identical to vitest.config.ts except it drops
// source-introspection meta-tests that regex-parse app source at import time.
// Stryker wraps every mutant in bracket guards (`stryMutAct_…`), so those
// parsers match nothing and fail Stryker's initial (baseline) run, which
// aborts the whole mutation pass.
//
// These tests still run in normal CI via vitest.config.ts — they are only
// skipped under Stryker. Excluding the *test* (rather than excluding the
// parsed routes from `mutate`) keeps those routes in the mutation set: any
// route with no real behavioural test surfaces as NoCoverage, which is the
// signal a mutation sweep is meant to find.
export default mergeConfig(base, {
  test: {
    exclude: [
      ...configDefaults.exclude,
      // Regex-parses src/app/api/onboarding/**/route.ts — see auth/onboarding-grants.test.ts.
      "**/auth/onboarding-grants.test.ts",
    ],
  },
});
