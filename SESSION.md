# Session state — last updated 2026-06-23 16:15 CT

## Just completed
- Diagnosed superadmin admin-access failure reported on `booking.ai-travelconcierge.com/admin`:
  - `/admin` on a tenant subdomain → proxy 404 by design (admin only on apex `ai-travelconcierge.com`).
  - On the apex → Next 404 from the admin layout gate. Operator IS a valid `platform_admins` row (auth_user_id `9ac93c3f-…`, current account). NOT a lost-creds issue.
  - Root cause: `getUser()` returns `AuthApiError: Invalid Refresh Token` on the apex — a present-but-invalid session cookie that was never cleared, so it failed on every request and the fail-closed admin gate wedged at 404. Confirmed via prod runtime logs (dpl_6hZLQaEUKMzkZ2Sdn68bEmfMYuRL).
  - Immediate user fix: full sign-out + clear `.ai-travelconcierge.com` cookies + fresh sign-in on the apex. User confirmed it works.
- Opened issue #1361 (self-heal + rotation-race follow-up).
- Implemented self-heal (PR #1362, branch `feature/auth-session-self-heal` off dev):
  - `ssr-client.ts`: `isInvalidSessionError()` (definitive 4xx vs transient) + `clearAuthCookies()` (domain-scoped purge).
  - `proxy.ts`: heal branch after getUser, before admin/login gates — clears bad cookie + redirects to /auth/reauth everywhere; clear-only on auth-flow paths to avoid loop.
  - Tests added; `pnpm verify` green (typecheck/lint/4760+147 tests/slop/guards, EXIT=0).

## In flight
- PR #1362 — pushed, CI running. Background poll (task bsybbifca) waits for required checks to settle.
- NEXT after green: run audit agents — d091-reviewer FIRST (Sonnet; no Opus triggers met), then pre-pr-reviewer. Then squash-merge + delete branch.

## Next step
- When CI green: invoke d091-reviewer then pre-pr-reviewer on PR #1362, fix any findings, merge.

## Blocked on user
- Nothing. (User confirmed the manual fix works and chose "redirect everywhere" behavior.)

## Open questions
- Deeper fix for the cross-subdomain rotating refresh-token race (why cookies go bad) — tracked as follow-up in #1361, not built this session.
