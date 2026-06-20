# Session state — last updated 2026-06-20 22:30 UTC

## Just completed
- Merged PR #1311 (#1273 AC3/AC4): RAG tenant-registry-reconcile hardening — onFailure PAGE PLATFORM ADMIN alert (fires once after Inngest retries exhaust) + redirect:"manual" + isCrossOriginRedirect guard so a cross-origin redirect can't strip the bearer; new unit test.
  - AC1 (env) + AC2 (drift) already resolved out-of-band: reconcile ran 2026-06-20 03:01 UTC, synced the active Lisa Travel row.
- Merged PR #1313: deploy.yml installs postgresql-client-17 (prod Supabase upgraded to PG 17.6; runner's pg_dump 16 refused to dump it → "Copy Prod DB to Staging" failed → blocked the whole release pipeline).
- Logged D-280 (PG17) to MEMORY.

## In flight
- Nothing in flight — clean checkpoint

## Next step
- Doc PR for the D-280 MEMORY entry + this SESSION update (in progress).

## Blocked on user
- **Re-cut release 0.7.2 after #1313 is on dev** (it is now): delete the failed `release/0.7.2` branch, then re-run the Release workflow for 0.7.2. deploy.yml runs from the release-branch copy, so the PG17 fix only applies to a release branch cut after #1313 merged.

## Open questions / follow-ups (issues filed)
- #1312 (opus): 2 orphan tenant_registry_shadow rows absent from main (Lisa Travel c351305b, Bigfoot Travel 820b4367) — ops decision whether to delete/prune.
- #1314 (sonnet): tenant-registry-reconcile shadow UPDATE has no zero-row guard (pre-existing Pattern-2-class; flagged by d091 on #1311, kept out to stay surgical).
- #1309 (sonnet): add tone-level<->label mapping test coverage (from #1305).

## Notes
- Prod Supabase main DB is Postgres 17.6. deploy.yml's DB-copy pins postgresql-client-17 — bump on next major upgrade (D-280).
- Model: still on Opus 4.8 (user's deliberate default this session).
