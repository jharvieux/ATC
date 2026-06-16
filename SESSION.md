# Session state — last updated 2026-06-16 15:00 UTC

## Just completed
- Diagnosed production 500 on lisa-travel.ai-travelconcierge.com: `null[0]` in `fetchTenantBranding` — PostgREST returns null (not []) for 1-to-1 embed with no row
- Fixed `fetch-tenant-branding.ts` with Array.isArray guard covering all three PostgREST embed shapes
- Added 2 regression tests (null embed = lisa-travel crash path; plain-object embed = 1-to-1 with row)
- Merged fix to dev as PR #1168 (squash); backport hotfix PR #1167 to release/beta061 closed as superseded
- Cut release/beta062 from dev HEAD — pipeline queued and will deploy to prod
- Added MEMORY entry D-247 for PostgREST 1-to-1 embed behavior
- Also merged PR #1166 earlier (BYO welcome email + SLA monitor, issues #1164/#1165 closed)

## In flight
- release/beta062 pipeline running — monitor at https://github.com/jharvieux/ATC/actions/runs/27643665196
  - On success: prod gets the branding fix, BYO email, SLA monitor, and all prior dev changes

## Next step
- Confirm release/beta062 deploys successfully and lisa-travel.ai-travelconcierge.com loads without 500
- Delete hotfix branch: `git push origin --delete hotfix/fetch-branding-null-guard`

## Blocked on user
- Nothing

## Open questions
- d091-reviewer nit (from #1166): duplicated `esc()` helper in branding-skip/route.ts + sub-host-review-sla-monitor.ts (~10 others in codebase). Could extract to `lib/email/escape.ts` as a follow-up.
- WARNING from prior review: `.limit(200)` on SLA candidate query — silent cap if >200 tenants breach per night. Acceptable for current scale.
- WARNING from prior review: `tenant.terminated` dispatch after CAS write — crash between them strands side-effects. Matches manual-reject pattern; low risk at current scale.
