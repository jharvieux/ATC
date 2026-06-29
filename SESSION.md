# Session state — last updated 2026-06-29 00:55 UTC

## Just completed
- Fixed 8 bugs (TA Chat nav, workspace "New chat" button, platform-domain API 401s) — PR #1540 merged
- Added automatic platform-domain → tenant-subdomain redirect for SaaS staff — PR #1541 merged
- Two d091 findings fixed during audit: missing applyRefreshedSession on redirect, dead primaryDomain guard
- MEMORY entry D-310 logged

## In flight
- Nothing in flight — clean checkpoint

## Next step
- Nothing pending from this session

## Blocked on user
- Nothing

## Open questions
- pre-pr-reviewer computes a different diff hash than CI by default; workaround: explicitly instruct it to use `gh api --paginate --slurp "repos/jharvieux/ATC/pulls/{PR}/files"` with the same jq+sha256 pipeline as the CI gate
- d091 NIT (unfixed, deferred): double getTenantByAuthUserId call for platform admins on chat/console paths — both calls are 60s cache hits after the first, no correctness risk; hoisting into a shared `let tenant` variable would clean it up
