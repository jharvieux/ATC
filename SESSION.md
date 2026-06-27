# Session state — last updated 2026-06-26 22:05 CT

## Just completed
- Triaged the 12 open `opus` issues; closed **#735** won't-do (OTP Redis).
- Shipped 3 DB PRs (merged to `dev`, **prod-apply gated**): **#1490/#1483** (124 FK covering indexes), **#1491/#1482** (auth_rls_initplan wrap, 50 policies, zero drift), **#1489** (stale-snapshot catch-up).
- **#1494 (part of #1492)** — `check:policy-snapshot` guard (DB-free; a policy migration must regen its `db/rls-snapshot-<app>.sql` in the same PR; wired into `verify` + Guards & Build with `fetch-depth: 0`) + CLAUDE.md "Migrations & RLS/grants snapshots" section. Live-validated; CI green.
- Logged **D-306** and **D-307** in MEMORY.

## In flight
- This docs PR (MEMORY.md + MEMORY-INDEX.md + SESSION.md). Otherwise clean checkpoint.

## Next step
- Decide on **#1492 part 2**: upgrade the post-merge `dev` drift `::warning` in `deploy.yml`'s rls-snapshot-diff step to auto-open/update a tracked issue. It's a production-pipeline workflow change — waiting on a go-ahead. If yes, that closes #1492.

## Blocked on user
- **Prod apply of the #1482 + #1483 migrations** — gated by no-prod-deploys. Prod advisors still show 50 `auth_rls_initplan` + 124 unindexed FKs + 86 unused indexes until the operator runs the prod migration apply.
- **#1492 part 2** go-ahead (deploy.yml change) — see Next step.

## Open questions
- #1484 (drop 86 unused indexes) is the third DB-perf item — engineering-ready but needs per-index review and is prod-apply gated.
- Shared-test-DB residue: my local `tests/security/*` runs (fixed-ID seed rows) may have left state; CI probe jobs seed/serialize, but worth a clean reset if a probe job flakes.
