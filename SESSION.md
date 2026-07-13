# Session state — last updated 2026-07-13 ~19:30 UTC (#444 tier-lookup slice shipped)

## Just completed
- **PR #1917 merged** (D-355): the executable slice of EPIC #444 — `lib/tenancy/get-tenant-tier-code.ts` shared helper, real tier wired into groups hero-image + billing page. Fixed two real defects found under the TODOs: phantom tier codes in `AI_ELIGIBLE_TIERS` (AI hero-image path was dead for sub-host tenants; consistency test added) and ungated `update_seats` (now §15.15 agency-only, fail-closed). Two audit rounds; re-audits clean.
- Epic #444 status comment posted: tier-TODO table fully dispositioned; `TODO(rbac-tenant-admin)` stays (§26 `tenant_admin` role doesn't exist); sub-issues #1257/#1260 operator-blocked, #1258/#1259 attorney-blocked (#427), #1262 launch gate.
- This docs PR: D-355 MEMORY entry + index line + SESSION checkpoint.

## In flight
- Nothing in flight — clean checkpoint once this docs PR merges.

## Next step
1. Operator works #1911 (validity-checks UI toggle, Copilot Autofix check, optional Vercel env sanity check, main-promotion decision).
2. Operator ops issues #1868/#1869/#1870 (RAG deploy secret, promote integration-tests-critical, GitGuardian resolutions).
3. Watch tonight's nightly: first run with the RAG suite + RAG DB migration-push + reset-per-run active (#1892/#1903/#1915).
4. Prod apply of 2026-07-13's four migrations is operator-gated (runbook §6): 20260722000020/21/22/23.

## Blocked on user
- #1911 (manual GH settings + main decision), #1868–#1870 (ops).
- #444 sub-issues: #1257/#1260 need operator go-decisions; #1258/#1259 need attorney sign-off (#427); #1262 is the last-merge launch gate.
- Merge-queue adoption = org-transfer decision (no urgency; recorded on #1896).
- Open decision issues: #1858 (deferred until real payments), #1805 (deferred).
- Dedicated-session backlog unchanged: #1585 #1523 #1623 #1740 #1247 #1358 #1728 #1724 #1782(210-index audit).

## Open questions
- #1876 stays open: booking-confirmation EMAIL template doesn't exist yet — when authored it must carry the §20.7 disclosure fail-closed.
- #1912 flaked again this session during `pnpm verify` (email-templates characterization test) — passed on immediate re-run. Recurrence count rising; worth early attention.
- #1901 (rollover audit-row dedup migration), #1909 (settings routes zero-row UPDATE no-op), #1913/#1914 (post-#1915 optional hardening).
- #1812 convention canon question (destructure-before-return vs #1791 style) still awaits a call — comment on the issue.
