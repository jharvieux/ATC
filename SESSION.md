# Session state — last updated 2026-07-16 22:05 UTC

## Just completed
- Issue sweep #5 (portable /issue-sweep, operator-approved plan + "include all supervised items", in-flight cap raised to 4): 11 PRs merged into dev (#1967, #1969, #1970, #1971, #1972, #1973, #1976, #1977, #1978, #1981, #1983), 29 issues closed (4 of them stale-with-evidence, 3 by operator decision), 7 follow-up issues filed → net −22. Full record in MEMORY D-360.
- Operator rulings recorded on-issue: #1923 residual risk accepted (closed), #1948/#1949 leave serial (closed), #1247/#1805/#1921/#1931 parked, #1968 fix approved (shipped in PR #1983), prod migration apply DECLINED.
- #1926 umbrella closed: canary bug fixed (#1968/PR #1983), prod drift consolidated into #1623.

## In flight
- Nothing in flight — clean checkpoint. (This docs PR is the last sweep artifact.)

## Next step
- **#1932 as a dedicated task on Fable** (operator ruling): middleware getUser() hybrid local-verify — getClaims() on the hot path, network getUser() only near token expiry; session refresh + rotated-cookie flush preserved on every response shape; #1361 self-heal distinction preserved; needs security review + staged rollout. Scope comment is on the issue.
- Verify tomorrow's nightly runs: contracts-canary should go green (PR #1983); if still red, reopen #1968. prod-drift-check stays red BY DESIGN until the operator schedules the prod migration apply (#1623).

## Blocked on user
- #1950 (reconcile-statement parallelization) — never ruled; parked. One word ("also serial") closes it.
- #1953 (companion/supervisor caching) — options documented on the issue; needs an operator pick.
- Prod migration apply session (#1623/#1740/#1927) — operator declined for now; drift alarm stays red until scheduled.

## Open questions
- #1982: email-templates-cascading-state flake persisted through 3 sightings AFTER the #1967 fix — the remaining race is probably test-side timing; evidence and acceptance criteria on the issue.
- Sweep follow-ups filed and open: #1974 (cron step.run isolation), #1975 (chat-counter SET-vs-RPC race), #1979 (email-templates god-component remainder), #1980 (mid-sentence TODO detection), #1984 (idempotency-key template pins), #1985 (serial-await CI gate).
