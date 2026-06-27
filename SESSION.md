# Session state — last updated 2026-06-26 21:30 CT

## Just completed
- Triaged the 12 open `opus`-labeled issues into engineering-ready / blocked.
- Closed **#735** (OTP brute-force Redis store) as won't-do per operator call.
- Shipped both clean engineering-ready perf advisors (merged to `dev`, **gated** behind operator prod-apply):
  - **#1483 / PR #1490** — `20260714000000_fk_covering_indexes.sql`: 124 covering indexes for unindexed FKs (plain `CREATE INDEX`, not CONCURRENTLY — see below).
  - **#1482 / PR #1491** — `20260715000000_rls_initplan_wrap_auth.sql`: wrapped `auth.uid()`/`auth.role()` → `(select …)` across 50 RLS policies + regenerated snapshot. Proven zero semantic drift.
- **#1489 / PR** — regenerated stale `db/rls-snapshot-main.sql` (caught up #1486's policy merge that #1488 exposed; was failing rls-snapshot-diff on every code PR).
- Filed **#1492** (opus) — hardening follow-up: static `policy-migration-needs-snapshot` lint + post-merge drift→issue.
- Logged **D-306** in MEMORY.md; updated MEMORY-INDEX.md.

## In flight
- This docs PR (MEMORY.md + MEMORY-INDEX.md + SESSION.md) into `dev`. Otherwise nothing in flight — clean checkpoint.

## Next step
- Merge the docs PR. Then: the two perf migrations are on `dev` but **not applied to prod** — prod advisors still show 50 `auth_rls_initplan` + 124/125 unindexed FKs + 86 unused indexes until the gated operator prod migration-apply runs.

## Blocked on user
- **Prod apply of #1482 + #1483 migrations** — gated by the no-prod-deploys rule. They take effect (and clear the advisors) only when the operator runs the prod migration apply.
- Remaining `opus` issues needing a decision before engineering: #1358 (Stripe live cutover design Qs), #1316 (staging refresh option), #1273 (RAG prod env repair), #1260/#1258/#1257 (Phase-2 / legal blockers), #1247 (host-fee spec confirmation), #890 (concierge inbound reply approach).

## Open questions
- #1492: want the static snapshot-guard built? It's filed and labeled opus; not started.
- 86 `unused_index` advisor (#1484) is the third DB-perf item — ready to start but needs per-index review + is prod-apply gated.
