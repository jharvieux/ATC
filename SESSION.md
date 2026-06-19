# Session state — last updated 2026-06-19 13:05 local

## Just completed
- **Voice-profile 500 fixed** (PR #1266, merged e3b72755). Root cause: `voice_samples`/`voice_profiles` were never in `TENANT_SCOPED_TABLES`, so `tenantClient.from("voice_*")` threw `UnregisteredTenantTableError` (fail-closed) → generic 500 on settings/voice. Whole feature was dead (all routes + Inngest extractor + resolve-voice-profile/draft-reply). Added both tables + regression test. `pnpm verify` green; both audit agents clean (Sonnet). Logged D-271.
- Opened issue #1267 — voice routes have no happy-path test coverage (why this shipped broken). Referenced from PR #1266 "Not in scope".

## In flight
- Nothing in flight — clean checkpoint on dev (e3b72755).

## Next step
- None committed. Merge to dev triggers the beta pipeline deploy of atc-main, so the user can re-test the Voice Profile page once that deploy lands.

## Blocked on user
- #1127 — transfer.reversed ledger unwind, spec §14.9 unspecified; needs spec owner decision
- #563, #1222 — APP_STAGING_URL / PLATFORM_DEFAULT_TENANT_ID Vercel Preview — ops actions required
- #895 — Re-enable BOOKING_CRONS_DISABLED: depends on product go-decision prongs 1+3
- #1258, #1259 (Phase 2 sub-issues) — blocked on attorney sign-off (#427)

## Open questions
- #1267 (voice-route coverage) is unrouted — agent-doable, will get an opus/sonnet label on next triage sweep unless user wants it picked up sooner.
