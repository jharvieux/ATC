/**
 * Contract recorder — re-records all fixture files against real APIs.
 *
 * Run nightly in CI (contracts-canary.yml) or manually:
 *   STRIPE_TEST_SECRET_KEY=sk_test_... ANTHROPIC_API_KEY_TEST=sk-ant-... npm run contracts:record
 *
 * Overwrites existing fixtures. After re-recording, the canary compares the
 * new response schema against the previous version and opens a GitHub issue
 * if the shape changed.
 *
 * TODO: Implement each recorder function once the application's wrapper
 * functions exist in src/lib/stripe/ and src/lib/anthropic/.
 */

const STRIPE_KEY = process.env.STRIPE_TEST_SECRET_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY_TEST;

if (!STRIPE_KEY || !ANTHROPIC_KEY) {
  console.error(
    "Error: STRIPE_TEST_SECRET_KEY and ANTHROPIC_API_KEY_TEST must be set.",
  );
  process.exit(1);
}

async function recordStripeFixtures() {
  // TODO: For each Stripe call site:
  // 1. Call the real Stripe test API
  // 2. Write request + response to tests/contracts/fixtures/stripe/...
  console.log(
    "TODO: Stripe recorder not yet implemented — requires src/lib/stripe/",
  );
}

async function recordAnthropicFixtures() {
  // TODO: For each Anthropic call site:
  // 1. Call the real Anthropic API
  // 2. Write request + response to tests/contracts/fixtures/anthropic/...
  console.log(
    "TODO: Anthropic recorder not yet implemented — requires src/lib/anthropic/",
  );
}

async function main() {
  console.log("Recording contract fixtures...");
  await recordStripeFixtures();
  await recordAnthropicFixtures();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
