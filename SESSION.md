# Session state — last updated 2026-06-05 15:20 UTC

## Just completed
- PR #764 merged: PKCE "code verifier not found in storage" fix
  - Root cause: auth-js `_removeSession()` marks code_verifier in `removedItems` BEFORE firing SIGNED_OUT; `applyServerStorage` in SIGNED_OUT event includes the deletion; middleware `setAll` zeroes the cookie in req.headers; callback reads empty value → error
  - Fix: skip `getUser()` in proxy.ts for all `/api/auth/*` routes
  - Regression test added in proxy-session-refresh.test.ts

## In flight
- `release/beta040` production deploy — needs manual approval in GitHub Actions (still pending from previous session)

## Next step
- Redeploy both Vercel projects (`atc-main` and `atc-rag`) to pick up new JWT env vars for cruisemapper ingest fix
- Verify cruisemapper fix: re-trigger `refresh-cruisemapper-static` Inngest job after redeploy
- Day-3 security PR: f001 (#715) + f028 (#741)
  - f001: `apps/main/src/app/api/trip-resources/route.ts` — add `.eq('tenant_id', tenantId)` filter
  - f028: quote acceptance public route — add `.eq('status', 'pending')` CAS guard + `safeAwaitRowCount(1)`

## Blocked on user
- GitHub `production` environment approval for beta040
- Vercel redeploy for JWT env var fix (user must trigger or approve)

## Open questions
- PR #758 security fixes (JWT key name, HMAC, SHA-256, fail-closed Inngest) are on dev but NOT in beta040
- 27 open security issues remain (#715–#752) after PRs #758 + #759
- beta041 (CSP form-action fix, PR #763) + beta042 (PKCE fix, PR #764) should be cut as a combined release
