# Session state — last updated 2026-06-18 19:20 UTC

## Just completed
- **#1190 triage** — all 34 baselined column-reader violations verified vs live schema + call sites; ~31 are genuine runtime bugs. Triage comment on #1190.
- **PR #1244 (merged)** — #1190 Severity A: booking/quote routes that 400'd (booking detail GET, list, submit, modify, quote accept, build-render-input).
- **PR #1245 (merged)** — #1190 Severity C email config: 6 files reading tenant email columns off `tenants` → moved to `tenant_branding`.
- **PR #1246 (merged)** — #1190 forums coordinator: 6 forum routes read `forums.coordinator_user_id` (doesn't exist) → embed `groups(coordinator_user_id)` via new `forumCoordinatorId()` helper.
- **Issue #1243 opened** — column-reader gate parses PostgREST `alias:column` backwards.
- **MEMORY D-263/D-264/D-265** added.
- Exceptions: 34 → 19 remaining (all the rest are decision-blocked or need data-model work).

## In flight
- Nothing in flight — clean checkpoint on dev (synced to ce31637c).

## Next step
- #1190 remaining work is decision-blocked (see below) OR needs data-model investigation (precruise). Either wait for user decisions, or pick up #1217 (Inngest test coverage, opus) which needs no input.

## Blocked on user (all #1190 remainder)
- **Host-fee `rule_ref`** (Severity B): `host_booking_fee_configs`/`tenant_host_fee_overrides` have no `rule_ref` column; submit route's host booking fee computes 0 today. Drop `rule_ref` vs migrate it? (money path)
- **`tenant_settings` columns**: `customer_bug_flow_enabled` + `import_auto_accept_threshold` never migrated. Add columns vs remove the per-tenant override read?
- **GDPR export data model**: `user-data-export-build.ts` assumes columns/filters that don't match schema (`bookings.source`, `auth_user_id` filter, RAG `knowledge_chunks.source_title`). Confirm user→bookings/chunks linkage before rewriting privacy code.
- **precruise bookings fields**: `customer_name`/`group_id`/`passenger_contact_email` not on bookings — need contacts join + name-format decision.
- #1127 — transfer.reversed ledger unwind: spec §14.9 unspecified; needs spec owner.
- #563 (`APP_STAGING_URL`), #1222 (`PLATFORM_DEFAULT_TENANT_ID` Vercel Preview) — ops actions.

## Open questions
- #1217 (Inngest job test coverage, opus) and #1235 (E2E GoTrue fixtures, sonnet) remain open and need no decisions.
- Model: session is on Opus (user set it for opus-labeled work). Left as-is per that intent — not reverted to Sonnet.
