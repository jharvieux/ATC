# Session state — last updated 2026-06-18 20:45 UTC

## Just completed (all #1190)
- **PR #1244 (merged)** — Severity A: booking/quote routes that 400'd.
- **PR #1245 (merged)** — Severity C email config → tenant_branding (6 files).
- **PR #1246 (merged)** — forums coordinator via linked group (forumCoordinatorId helper).
- **PR #1248 (merged)** — Severity B host booking fee (was computing $0): filter host_adapter, dollars→cents (new dollarsToCents helper), percent-of-gross-commission, rule_ref=row id. Worked-example tests.
- Issues opened: #1243 (gate alias-parse bug), #1247 (host fee tiered + min_threshold deferred).
- MEMORY D-263..D-266. Exceptions: 34 → 13 remaining.

## In flight
- On dev, clean (synced to 517792c5). About to start the GDPR export PR.

## Next step (user decisions captured — proceed)
1. **#3 GDPR export** (`user-data-export-build.ts` + RAG `export-user-chunks`): resolve auth_user_id→users.id, repoint bookings/conversations to user_id, fix legal_consents columns (document_type/document_version/acted_at), RAG knowledge_chunks (ingested_at, drop source_title). Export the obvious set (profile, bookings, conversations, consents, chunks). Privacy — verify FKs from schema.
2. **#2 tenant_settings**: add `import_auto_accept_threshold` column via migration (decision A); remove the dead `customer_bug_flow_enabled` read in bug-intent-recognizer.ts (decision B). Remove both exceptions.
3. **#4 precruise**: bookings.group_id→group_booking_id; customer_name/passenger_contact_email via primary_contact_id→contacts (first_name only). Remove 3 exceptions.

## Blocked on user
- #1127 — transfer.reversed ledger unwind (spec §14.9 unspecified).
- #563 (APP_STAGING_URL), #1222 (PLATFORM_DEFAULT_TENANT_ID Vercel Preview) — ops.

## Open questions
- After the 3 remaining #1190 items, only messages.user_id (legit false positive) stays exceptioned → #1190 can close.
- #1217 (Inngest test coverage, opus), #1235 (E2E GoTrue fixtures, sonnet) still open.
- Session on Opus (user set it for opus work). Not reverted.
