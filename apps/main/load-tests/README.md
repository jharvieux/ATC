# k6 load tests

Per BP30 §30.7: these scripts are **out of band**. They do NOT run in CI.
Execute manually against a dedicated load-test environment before major
releases (every 4–8 weeks) and quarterly as routine health.

## Setup

Install k6 locally: https://k6.io/docs/get-started/installation/

Each script accepts the target base URL via the `BASE_URL` env var:

```sh
BASE_URL=https://loadtest.ai-travelconcierge.com k6 run sustained-chat-load.js
```

Per-script tuning knobs (`VUS`, `DURATION`, etc.) are declared at the top
of each file with sensible defaults pulled from §30.7. Override at the
shell to scale up or down for the run.

## Scenarios (§30.7)

| Script | What it exercises | Targets |
|---|---|---|
| `sustained-chat-load.js` | 500 concurrent conversations for 30 min | chat p95 < 5s, error rate < 0.1% |
| `burst-signups.js` | 100 OAuth signups in 60 seconds | signup p95 < 3s, error rate < 0.1% |
| `group-invite-blast.js` | 1000-invitee group send | invite-send completion < 60s |
| `rag-retrieval-load.js` | 1000 retrievals/sec for 5 min | retrieval p95 < 500ms |
| `stripe-webhook-flood.js` | 5000 webhooks in 10 min | webhook-handler p95 < 500ms |
| `multi-tenant-fanout.js` | 100 tenants × 50 customers × 5-msg chats | overall p95 across the matrix |

## Smoke-validate each script

A `k6 run --no-summary --vus 1 --duration 1s` against any script will
parse + dry-run it. Useful as a syntax check after edits.

## Operator provisioning

Load tests run against a dedicated environment (separate Supabase project
+ Vercel project), not staging — staging carries pg_dump-restored real
PII per BP25 / D-058 controls. See `docs/runbooks/load-testing.md` for
the provisioning checklist.
