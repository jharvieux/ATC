# k6 load tests (§30.7)

Out-of-band load tests for the six §30.7 scenarios. **These are NOT run
on every PR** — too expensive. The spec calls for execution before
major releases (every 4-8 weeks) and quarterly as a routine health
check.

CI does **not** invoke these. They run manually against a dedicated
load-test environment.

## Scenarios

| Scenario | Script | Thresholds |
|---|---|---|
| Sustained chat load | `chat-sustained.js` | chat p95 < 5s, error rate < 0.1% |
| Burst signups | `signups-burst.js` | 100 OAuth signups in 60s, DB pool holds |
| Group invite blast | `group-invite-blast.js` | 1000-invitee group send, email queue holds |
| RAG retrieval load | `rag-retrieval.js` | 1000 retrievals/sec for 5 min, p95 < 500ms |
| Stripe webhook flood | `stripe-webhook-flood.js` | 5000 webhooks in 10 min, idempotency holds |
| Multi-tenant fan-out | `multi-tenant-fanout.js` | 100 tenants × 50 customers × 5 msg conversations |

## Prerequisites

1. **Install k6** locally or on the load-test runner:
   ```bash
   brew install k6        # macOS
   # OR
   docker pull grafana/k6
   ```
2. **Provision the load-test environment.** This is NOT staging — it's
   a dedicated environment with:
   - Its own Supabase project (Pro tier, separate from prod)
   - Its own Vercel project (`atc-load-main`, `atc-load-rag`)
   - The same migrations applied
   - Synthetic test tenants seeded (see `seed-load-tenants.ts` below)
3. **Set env vars** in the shell that runs k6:
   ```bash
   export K6_BASE_URL="https://load-test.example.com"
   export K6_ANTHROPIC_API_KEY="sk-ant-test-..."
   export K6_STRIPE_WEBHOOK_SECRET="whsec_..."
   export K6_LOAD_TENANT_PREFIX="load-tenant-"
   ```

## Running a scenario

```bash
k6 run tests/load/k6/chat-sustained.js
```

For Docker:

```bash
docker run --rm -i \
  -e K6_BASE_URL \
  -e K6_ANTHROPIC_API_KEY \
  grafana/k6 run - < tests/load/k6/chat-sustained.js
```

## Outputs

Each script writes a summary JSON to `reports/load/<scenario>-<date>.json`.
Track these in your release-cadence calendar — comparison week-over-week
catches gradual regression.

## What "pass" means

A scenario passes if **all** of the following hold:

- p50 / p95 / p99 stay below the targets in the table above
- Error rate < 0.1% across the run
- No memory growth across the run (check `vu_active` curve in the JSON
  output — should be flat once steady-state)
- No DB connection pool exhaustion (Supabase dashboard)
- No Anthropic rate-limit responses (429) from the application

If any check fails, **do not ship the release** until the underlying
issue is understood. Load test results inform the release decision; they
are not advisory.

## See also

- `§30.7` in the spec — full scenario definitions + thresholds
- `docs/runbooks/disaster-recovery.md` — DR procedures
- `docs/specs/reality-delta.md` — known deviations
