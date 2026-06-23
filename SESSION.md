# Session state — last updated 2026-06-23 16:55 CT

## Just completed
- Diagnosed superadmin admin-access failure (booking subdomain + apex /admin). NOT lost creds — operator's `platform_admins` row intact (auth_user_id `9ac93c3f-…`). Root cause: `getUser()` → `AuthApiError: Invalid Refresh Token` on a stale cross-subdomain session cookie that never self-cleared, wedging the fail-closed admin gate at 404 (prod runtime logs, dpl_6hZLQaEUKMzkZ2Sdn68bEmfMYuRL).
- Immediate fix (operator confirmed working): full sign-out + clear `.ai-travelconcierge.com` cookies + fresh sign-in on the apex.
- **PR #1362 (merged to dev)** — middleware self-heal: `isInvalidSessionError` + `clearAuthCookies` in `ssr-client.ts`; heal branch in `proxy.ts` (clear bad cookie + redirect to /auth/reauth everywhere; clear-only on /auth,/api/auth,/signup funnel except /signup/complete). Both audit agents clean. Verify green. Playwright (non-required) red = pre-existing missing TEST_E2E_OWNER_* creds, unrelated.
- Issue #1361 root-caused (rotation race); decision logged D-293.
- Issue #1363 (reauth double-encode) — investigated, NOT a bug (balanced encode/decode; `safeNextFor` preserves query), CLOSED.
- D-293 written to MEMORY.md + MEMORY-INDEX.md.

## In flight
- Docs PR for MEMORY/MEMORY-INDEX/SESSION updates (this checkpoint) — on a docs/* branch, doc-only (audit-exempt).

## Next step
- Operator action (their call, approved): bump Supabase `refresh_token_reuse_interval` 10s → 30s in the prod dashboard (project mfaknjyqiwcjojukcnea → Authentication settings). Confirm current value first. Then #1361 can close.
- Minor deferred: add a doc-comment noting the `/api/auth/*` arm of `isAuthFlowPath` (proxy.ts) is currently unreachable — fold in next time proxy.ts is touched (both audit agents flagged; not blocking).

## Blocked on user
- Reuse-interval dashboard change is the operator's to apply (prod auth config). Waiting on them to confirm current value / apply.

## Open questions
- Pre-existing CI gap: authed Playwright specs can't run (missing TEST_E2E_OWNER_* secrets) — surfaced but not tracked; raise with operator whether to provision CI test creds.
