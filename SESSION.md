# Session state — last updated 2026-06-12 20:15 UTC

## Just completed
- PR #1046 merged: fix signup 401 loop — changed `createRequestScopedClient` to use `req.cookies.getAll()` for NextRequest inputs instead of `parseCookieHeader`, matching all other SSR clients. Root cause confirmed via Supabase auth logs (zero `/auth/v1/user` calls from signup route = session never read).

## In flight
- Nothing in flight — clean checkpoint

## Next step
- Verify the signup fix end-to-end on staging: complete an agency OAuth flow and confirm tenant is created + user lands on dashboard (not redirected back to /signup).
- Remaining open issues: #1003 (D-201 vs D-170 role-scope alignment review — user's call whether to act), #1044 (remainingCount error-swallow in flush.ts — non-trivial fix, tracked).

## Blocked on user
- Staging verification of signup fix (end-to-end OAuth → tenant creation flow).

## Open questions
- #1044 (remainingCount swallow in flush.ts) — non-trivial fix, tracked as issue.
- #1003 — D-201 vs D-170 role-scope alignment — user hasn't decided whether to act.
