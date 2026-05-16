# Contract Tests

## What contract tests cover

Contract tests verify that the application's Stripe and Anthropic wrapper functions produce the correct API calls and handle responses correctly. They catch two things:

1. **API schema drift** — Stripe or Anthropic changes a response field name or type. The nightly canary detects this before it breaks production.
2. **Wrapper regression** — a code change accidentally changes what the application sends to Stripe or Anthropic. The PR-track gate catches this.

What they do NOT catch: behavioral regressions inside the SDKs themselves, or changes in AI model behavior (that's the evaluation harness in §12).

## How it works

- **PR-track:** MSW intercepts HTTP calls and replays committed fixture JSON files. No real API calls. Fast and free.
- **Nightly canary:** Re-records all fixtures against real Stripe test mode and real Anthropic API. Compares response schemas (key names and types, not values). Opens a GitHub issue if the schema drifted.

## How to add a new contract

1. Add a fixture JSON file to `tests/contracts/fixtures/<provider>/<resource>/<scenario>.json` — see existing files for the schema.
2. Add a test to `tests/contracts/<provider>/*.test.ts` that calls the application wrapper and asserts on the result.
3. Run `npm run contracts:record` locally (with real API credentials) to populate the fixture with a real recorded response.
4. Commit both the fixture and the test.

## How to handle a legitimate API schema change

When the nightly canary opens a drift issue:

1. Review the diff in the issue body.
2. If the change is expected (Stripe added a new field, Anthropic changed a response format):
   - Update the application code that consumes the changed field.
   - Re-record the fixtures: `STRIPE_TEST_SECRET_KEY=... ANTHROPIC_API_KEY_TEST=... npm run contracts:record`
   - Commit the updated fixtures alongside the application code change in one PR.
3. If the change is unexpected — escalate. An unexpected schema change from Stripe or Anthropic may indicate an SDK version change or a breaking API change that needs more investigation.

## Making the canary a hard failure

The `contracts-canary.yml` workflow runs with `continue-on-error: true` during the rollout period. Once contracts are fully wired up (all Stripe and Anthropic wrapper functions exist and are recorded), flip both `continue-on-error` lines to `false` in `.github/workflows/contracts-canary.yml`. Log this change in `MEMORY.md`.

## Local commands

```bash
# Run contract tests (replay mode — no real API calls):
npm run test:contracts

# Re-record all fixtures against real APIs:
STRIPE_TEST_SECRET_KEY=sk_test_... ANTHROPIC_API_KEY_TEST=sk-ant-... npm run contracts:record
```
