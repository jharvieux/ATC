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

## Recorder design (per #471 fix)

`scripts/record-contracts.ts` orchestrates a recording session against real
APIs. Stripe is dependent-resource (subscription needs a customer + price;
cancel needs that subscription's id; account_link needs that account's id),
so the recorder substitutes placeholder ids captured from earlier calls in
the same session. Anthropic fixtures are independent and recorded in
parallel-safe sequence.

A Stripe test-mode price is created or reused via
`lookup_key=contracts_canary_test_price` so the recorder doesn't accumulate
prices across runs. Customers and Connect accounts are left in test mode
(no cost, no orchestration cost to clean them up). Subscriptions are
cancelled at end-of-session to keep the test dashboard tidy.

## Local commands

```bash
# Run contract tests (replay mode — no real API calls):
pnpm test:contracts

# Re-record all fixtures against real APIs:
STRIPE_TEST_SECRET_KEY=sk_test_... \
ANTHROPIC_API_KEY_TEST=sk-ant-... \
pnpm tsx scripts/record-contracts.ts
```

## GitHub secrets required for the nightly canary

- `STRIPE_TEST_SECRET_KEY` — Stripe test-mode secret key
- `ANTHROPIC_API_KEY_TEST` — Anthropic API key, ideally a dedicated test key

If either is missing, the recorder fails at startup and the canary workflow
fails loudly. That's the desired behavior — silent fail was the bug fixed
in #471.
