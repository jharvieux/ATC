# Session state — last updated 2026-06-26 22:40 CT

## Just completed
- Triaged the 12 open `opus` issues; closed **#735** won't-do (OTP Redis).
- Shipped 3 DB PRs (merged to `dev`, **prod-apply gated**): **#1490/#1483** (124 FK covering indexes), **#1491/#1482** (auth_rls_initplan wrap, 50 policies, zero drift), **#1489** (stale-snapshot catch-up).
- **#1492 fully closed** — both halves of the snapshot-diff hardening:
  - **#1494** — `check:policy-snapshot` guard (DB-free; policy migration must regen its snapshot in the same PR; in `verify` + Guards & Build) + CLAUDE.md "Migrations & RLS/grants snapshots" section.
  - **#1496** — `deploy.yml` post-merge backstop: dev-push drift now opens/reuses a single `snapshot-drift` issue (skip-if-open, no spam) instead of warn-only.
- Logged **D-306, D-307, D-308** in MEMORY.

## In flight
- This docs PR (MEMORY.md + MEMORY-INDEX.md + SESSION.md). Otherwise clean checkpoint.

## Next step
- Nothing required. The snapshot guard stack is complete (check:policy-snapshot → rls-snapshot-diff/grants → post-merge issue backstop).

## Blocked on user
- **Prod apply of the #1482 + #1483 migrations** — gated by no-prod-deploys. Prod advisors still show 50 `auth_rls_initplan` + 124 unindexed FKs + 86 unused indexes until the operator runs the prod migration apply.

## Open questions
- #1484 (drop 86 unused indexes) is the third DB-perf `opus` item — engineering-ready but needs per-index review and is prod-apply gated. Not started.
- Shared-test-DB residue: my local `tests/security/*` runs (fixed-ID seed rows) may have left state; CI probe jobs seed/serialize, but worth a clean reset if a probe job flakes.
