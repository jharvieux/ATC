# Session state — last updated 2026-06-18 21:30 UTC

## Just completed
- **#1190 CLOSED — complete.** Triaged all 34 baselined column-reader violations; ~31 were genuine runtime bugs. Fixed across 7 merged PRs:
  - #1244 Severity A (booking/quote routes that 400'd)
  - #1245 tenant email config → tenant_branding (6 files)
  - #1246 forums coordinator via linked group (forumCoordinatorId helper)
  - #1248 host booking fee (was $0): filter/units/percent-base + dollarsToCents helper
  - #1249 CCPA export user_id linkage + multi-tenant disclosure
  - #1250 precruise recipient from contact (first name only)
  - #1251 tenant_settings: add import_auto_accept_threshold column (migration 20260705000000) + drop dead bug-flow read
- Exceptions 34 → 1 (messages.user_id = documented false positive).
- MEMORY D-263 … D-269 added.

## In flight
- Nothing in flight — clean checkpoint on dev (synced to 34fa92fb).

## Next step
- #1217 (Inngest background-job test coverage, opus-labeled) is workable and needs no decisions — natural next pickup.

## Blocked on user
- #1127 (opus) — transfer.reversed ledger unwind: spec §14.9 unspecified; needs spec owner.
- #563 (APP_STAGING_URL), #1222 (PLATFORM_DEFAULT_TENANT_ID Vercel Preview) — ops actions.

## Open questions / follow-ups opened this session
- #1243 — column-reader gate parses PostgREST alias:column + !inner embeds incorrectly (caused the 1 remaining FP).
- #1247 — host booking fee: implement tiered fee_type + minimum_commission_threshold (unbuilt §12.6 features).
- Open opus issues remaining: #1217 (test coverage), #1127 (blocked).
- Session on Opus (user set it for opus work). Not reverted.
