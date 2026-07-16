# Session state — last updated 2026-07-16 03:20 CDT (issue sweep: 9 batches merged)

## Just completed

Portable `/issue-sweep` over 49 open issues. 43 triaged (6 excluded on `needs-human-fix`), 12 batches planned; operator adjusted scope (dropped #426/#1260/#1262/#1247 as tracking/gated, added 8 supervised items, later skipped #1858).

**9 batches merged** — PRs #1924, #1925, #1929, #1930, #1938, #1943, #1945, #1946, #1947. **2 parked** as already-fixed (#1876, #1523). **1 in audit** (#1959).

Real bugs found and fixed:
- **#1740** — `compliance-nightly` SELECTed `email_send_pattern` from `tenants`; it lives on `tenant_branding`. The failed SELECT tripped `if (tenantErr) return`, so the cron aborted nightly at 04:00 UTC and **30/60/90-day inactivity reminders were silently never sent**. Both read guards now throw (matching `group-reminder-cadence.ts:96-97`).
- **#1909** — admin settings PUT: the #1900/#1906 guard only fires when *every* key returns zero rows. A mixed PUT returned 200 **and published a RAG-sync event** for the applied key while the other silently diverged.
- **#1585** — auth tax. The issue proposed a "trusted internal header"; that would have **fail-opened** (`/api/auth/*` is exempt from the proxy's `getUser()` at `proxy.ts:285-287`, yet six routes there call `assertPermission`). Executor refused it, verified locally via `getClaims()` instead, left `proxy.ts` untouched. Cross-Tenant Probe green.
- **#1919/#1920** (dupes) — the nightly failure was **cleanup-only**: `afterAll` deleted fixture tenants via PostgREST, whose per-request transaction can't carry `SET LOCAL app.allow_tenant_hard_delete`. All three assertions passed every night.

**Repo-wide merge freeze resolved.** `public.tenant_registry` was an orphaned relic on the live RAG DB — migration `0007` declares `DROP TABLE IF EXISTS ... CASCADE`, but it never took effect while the ledger recorded 0007 applied. Not an exposure (0 rows, no SELECT grant, 0 code refs). Operator approved the drop; the regenerated snapshot came back **byte-identical**, proving the snapshot was always right and the orphan was the sole discrepancy. #1944 and #1941 closed.

**38 issues filed** (#1921–#1958, excluding the PRs in that range).

## In flight

- **PR #1959** (`feature/sweep-ci-1904`) — fixes #1914 (RAG test-DB reset-per-run; ledger genuinely wedged with `42P07`, the root cause behind #1919's nightly failures). pre-pr audit clean; **d091 audit still running** (Opus — verifying the reset cannot target a non-throwaway DB). #1904 closed as already-fixed by `55ba3f4b`; #1913 left open (gated on `STAGING_PIPELINE_ENABLED`, verified still `false`).
- Sweep ledger at `.git/issue-sweep-ledger.json` — delete once #1959 lands.

## Next step

Land #1959: wait for the d091 marker, re-run `pr-audit-section-check`, merge with an explicit `--body` override (see the closing-keyword hazard below), then delete the ledger.

## Blocked on user

- **#1523** — enable leaked-password protection (Supabase dashboard). The RPC-hardening half was verified a **no-op**: the advisor's `REVOKE EXECUTE` recommendation is a false positive that would break RLS platform-wide (proved on the test DB; already recorded in the advisor baseline, #1369/#1621).
- **#1740** — 2 of 3 errors need prod DDL. The `review_submitted_at` ledger/DDL divergence **cannot self-heal**: `ADD COLUMN IF NOT EXISTS` no-ops forever against a ledger that already claims it. Plus the `attribution_rollup` MV refresh.
- **#1926** — `prod-drift-check` + `contracts-canary` failing daily. This is the detector for exactly the drift class above, and it was dark while that drift sat undetected.
- **#1950** — is `reconcile-statement-automated.ts` in scope for perf work, or excluded like the `payouts-*.ts` family?
- **Prod is ~172 commits behind dev.** v0.9.1 is tagged 2026-07-09; #1842 merged 07-13 and is in neither `main` nor the tag. This blocks #1843's strict flip and any tolerant-then-strict rollout. A release cut is a scheduling call.
- Carried over: #1911, #1868–#1870, #444 sub-issues (#1257/#1260 operator, #1258/#1259 attorney via #427, #1262 launch gate).

## Open questions

- **Closing-keyword hazard — bit 3× this sweep.** GitHub parses `close #N` / `fixes #N` / `resolves #N` **even inside a sentence that negates it**: "does not close #1919" still closes it. It hides in **commit messages** too (repo squashes with `COMMIT_MESSAGES`). `fix(#N):` is parenthesized and safe. Verify via `closingIssuesReferences` in GraphQL — never by reading prose — and merge partial-fix PRs with an explicit `--body`.
- **`deploy.yml:415` skips the RLS drift step on `dev` pushes** (runs only on `pull_request`/`merge_group`/`release/*`), so `dev` can never catch out-of-band drift. It surfaces later and blocks *every* PR at once — which is how #1944 was found. Arguably by design; worth a decision.
- **The tracker is stale.** 6 issues worked were already fixed or misdiagnosed (#1876, #1523, #1773, #1904, #1909's stated symptom, #1912's framing). Executors were told to verify before implementing, which is the only reason it surfaced.
- **#1912 reopened** — PR #1943 narrowed the flake window but didn't close it. The mount effect's `setEditState` can land *after* the keystroke and overwrite it; `findByDisplayValue` survives a slow update but not a later one. Durable fix: gate the reset effect on an actual type *change*, not the mount-time set.
- **#1876 closed** — the §20.7 disclosure was already live on both surfaces (PR #1907). The booking-confirmation **email** still doesn't exist though the page promises one → #1921.
- **#1812 convention question resolved**: PR #1946 follows the #1791 pattern (no destructure-before-return); ~15 components remain, enumerated on the issue.
