# Session state — last updated 2026-06-18 23:15 UTC

## Just completed
- **#1190 triage** — verified all 34 baselined column-reader violations vs live schema + call sites. ~31 are GENUINE runtime bugs (PostgREST 400 / silent-wrong), only `messages.user_id` is a clean false positive. Full severity-grouped triage posted as a comment on #1190.
- **PR #1244 (merged)** — #1190 **Severity A** (routes that 400 today): bookings/[id] GET, bookings list GET, submit, modify, quotes accept, build-render-input. Real columns + in-code mapping (no aliases). Exceptions 34→29. New regression tests (detail-get, list-get) + hardened submit/modify/build-render-input guards. Both audits clean (Opus first, Sonnet re-run).
- **Issue #1243 opened** — column-reader gate parses PostgREST `alias:column` syntax backwards (found during #1244; worked around).
- **MEMORY D-263** added.

## In flight
- Nothing in flight — clean checkpoint on dev (synced to f64ca96e).

## Next step
- Decide whether to start #1190 **Severity B/C** — needs 3 user decisions first (see Blocked on user). Then #1217 (Inngest test coverage). #1127 still blocked (spec owner).

## Blocked on user
- **#1190 Severity B** — host booking fee `rule_ref` has no column (drop vs migrate?). Money path computes 0 today.
- **#1190 Severity C** — `tenant_settings.customer_bug_flow_enabled`/`import_auto_accept_threshold` never migrated (add columns vs remove override read?); and GDPR export (`user-data-export-build.ts`) user→bookings/chunks linkage before rewriting privacy code.
- #1127 — transfer.reversed ledger unwind: spec §14.9 leaves post-payout money movement unspecified; needs spec owner input.
- #563 — set `APP_STAGING_URL` secret in GitHub (ops).
- #1222 — set `PLATFORM_DEFAULT_TENANT_ID` in Vercel Preview env (ops).

## Open questions
- #1190 Severity C is mostly mechanical wrong-table/wrong-column renames (abuse-notify, group emails, precruise, forums coordinator) — could ship those without decisions, splitting off the 2 decision-blocked items (tenant_settings, GDPR export). Confirm sequencing with user.
- #1217 (Inngest job test coverage, opus) and #1235 (E2E GoTrue fixtures, sonnet) remain open.
