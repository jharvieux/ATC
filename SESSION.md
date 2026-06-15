# Session state — last updated 2026-06-15 12:10 UTC

## Just completed
- Investigated "reauth_required" error on ICA acceptance during onboarding
- Found two bugs:
  1. Root cause: `readAuthTime` in `assert-permission.ts` always returned null because Supabase GoTrue JWTs use `amr[].timestamp` (not `auth_time`) for the authentication timestamp. This caused ALL sensitive routes (/api/onboarding/ica, /api/tenant/billing, /api/commissions, /api/user/data) to reject unconditionally.
  2. ICA page's `handleSubmit` showed raw "reauth_required" string instead of redirecting to /auth/reauth.
- Fixed both bugs in PR #1104 (fix/ica-reauth-redirect):
  - `readAuthTime` now falls back to max `amr[].timestamp`; exported for testing
  - Added 7 unit tests in `test/unit/auth/read-auth-time.test.ts`
  - ICA page redirects to `/auth/reauth?return=/onboarding/ica` + resets submitting state
- All CI checks pass except pr-audit-section-check awaiting re-run (hash mismatch from timing; agents re-ran, body edit triggered re-check)

## In flight
- PR #1104 (fix/ica-reauth-redirect) — waiting for pr-audit-section-check to pass, then merge

## Next step
- Merge PR #1104 once pr-audit-section-check goes green
- Delete feature branch after merge
- Note: this fix unblocks the entire sensitive-routes system — billing, commissions, user data deletion were ALL broken with the same reauth_required error

## Blocked on user
- Nothing

## Open questions
- Other sensitive routes (billing, commissions, user/data) should now work too — worth a smoke test post-merge
