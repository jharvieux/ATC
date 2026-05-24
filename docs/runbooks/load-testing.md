# Load testing

**Owner:** platform operator
**Spec refs:** §30.7, §30.13 (third call-out)
**Audience:** anyone planning to run k6 against the platform

## When to run

Per §30.7 + §30.13:

- **Before every major release** (every 4–8 weeks).
- **Quarterly** as routine health regardless of releases.
- **Monthly during the first 6 months post-launch** (§30.13: doubled cadence while production behaviors are still settling).
- **On demand** after any change that meaningfully alters the request shape: new AI-call site, new RAG retrieval path, new webhook handler, big DB migration.

Load tests are explicitly **out of CI** (§30.7). They run against a
dedicated load-test environment, not staging — staging carries
pg_dump-restored real PII (BP25/D-058) and cannot accept synthetic
high-volume traffic without corrupting that data.

## Where the scripts live

`apps/main/load-tests/` — six k6 scenarios covering the §30.7 table.

| Script | Scenario |
|---|---|
| `sustained-chat-load.js` | 500 concurrent conversations for 30 min |
| `burst-signups.js` | 100 OAuth signups in 60s |
| `group-invite-blast.js` | 1000-invitee group send |
| `rag-retrieval-load.js` | 1000 retrievals/sec for 5 min |
| `stripe-webhook-flood.js` | 5000 webhooks in 10 min (requires pre-signed payload sidecar) |
| `multi-tenant-fanout.js` | 100 tenants × 50 customers × 5-msg chats |

Each script declares §30.7 thresholds inline (chat p95 < 5s, RAG p95 < 500ms, etc.). k6 exits non-zero if any threshold is missed.

## Environment provisioning

**Load-test environment** is a separate set of resources from dev / staging / production:

- Separate Supabase project (Pro tier or higher to avoid bumping into Free-tier limits).
- Separate Vercel project for the main app, and another for the RAG service.
- Separate Anthropic + OpenAI keys with usage caps high enough to absorb the run.
- Separate Stripe **test-mode** keys.
- Resend test mode (or disabled — most scenarios don't actually send mail).

Operator checklist for first-time provisioning:

1. Create the load-test Supabase project; populate with the BP30 fixtures (`pnpm fixtures:load`).
2. Create the load-test Vercel project(s); copy the production env-var set, replace secrets with load-test values, then verify `verifyEnvAtBoot()` passes.
3. Mint long-lived service-JWT keypair specifically for load tests; store the public key on the RAG project and the private key in a 1Password vault entry called `atc-loadtest-service-jwt`.
4. Bootstrap a tenant set for `multi-tenant-fanout`: 100 tenants, each with 50 sandbox customers, each with a bearer token. Save the token map to `tenant-tokens.json` (gitignored) and pass via `LOADTEST_TENANT_TOKENS=./tenant-tokens.json`.
5. Pre-sign a Stripe webhook payload set for `stripe-webhook-flood`: use `scripts/build-stripe-sigset.ts` (script TBD per the BP30 follow-up list) to generate `stripe-sigs.json`. Pass via `STRIPE_LOAD_SIGSET=./stripe-sigs.json`.

## Running a single scenario

```sh
# Install k6 if needed
brew install k6

cd apps/main/load-tests

# Sustained chat
BASE_URL=https://loadtest.ai-travelconcierge.com \
LOADTEST_BEARER=$(cat ~/.loadtest-bearer) \
k6 run sustained-chat-load.js

# RAG retrieval — hits the RAG service URL directly
RAG_BASE_URL=https://rag.loadtest.ai-travelconcierge.com \
LOADTEST_SERVICE_JWT=$(cat ~/.loadtest-service-jwt) \
LOADTEST_TENANT_ID=33333333-0000-0000-0000-00000000000a \
k6 run rag-retrieval-load.js
```

k6 prints a summary at the end. Any failed threshold yields a non-zero
exit and bold red output.

## Smoke-validate script syntax

After editing a script, sanity-check the syntax with a tiny run:

```sh
k6 run --vus 1 --duration 1s --no-summary apps/main/load-tests/<name>.js
```

If k6 parses + executes one iteration successfully, the script is well-formed.

## Interpreting results

| Metric | Threshold (§30.7) |
|---|---|
| Chat `http_req_duration` p95 | < 5000 ms |
| Signup `http_req_duration` p95 | < 3000 ms |
| RAG retrieval `http_req_duration` p95 | < 500 ms |
| API non-AI `http_req_duration` p95 | < 500 ms |
| Webhook `http_req_duration` p95 | < 500 ms |
| Error rate (`http_req_failed`) under load | < 0.1 % |

If any threshold is missed:

1. Capture the k6 summary in the run-log.
2. Pull the corresponding Vercel / Supabase performance metrics for the run window.
3. If it's a regression vs the prior cadence, file an investigation issue tagged `perf-regression`.
4. If it's a known constraint (e.g., Anthropic rate-limit hit), document in the run-log and adjust the scenario's RPS or VU count.

## Cost awareness

- Anthropic calls in `sustained-chat-load.js` are **real**. At 500 VUs × 30 min × 1 message / 30 s ≈ 15,000 chat turns × ~$0.03 per turn ≈ $450 per run. Budget accordingly.
- RAG retrievals do NOT call the LLM; cost is OpenAI embeddings only — ~$0.0001 per retrieval × 300,000 retrievals ≈ $30.
- The other scenarios are negligible cost (no AI calls).

If full sustained-chat is too expensive for a given run, scale down with
`VUS=100 DURATION=10m` for a smoke variant — still exercises the
concurrency path without the full bill.

## Out-of-scope (explicitly NOT load-tested)

- The signup OAuth flow against real Google/Microsoft/Facebook providers — they will rate-limit us first. The burst-signups scenario hits the `oauth-initiate` route only (which redirects); the actual provider exchange is mocked at the load-test environment level.
- Inngest function execution at scale — Inngest cloud has its own load profile, separate from ours.
