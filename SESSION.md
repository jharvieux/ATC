# Session state — last updated 2026-06-23 20:35 CT

## Just completed
- **Security-alert triage sweep** across all five surfaces (81 open alerts → real signal only):
  - **Secret scanning (2 → 0):** both false positives (local-dev anon JWT mislabeled "Service Key"; `whsec_` test fixture). Dismissed `used_in_tests`. No rotation needed.
  - **Code scanning (41 → 0):** 4 prod-code findings fixed + regression-tested (**PR #1366**, merged); 37 test/fixture/script alerts dismissed.
  - **Dependabot (38 → patched):** 28 phantom from a stray root `package-lock.json` — deleted + gitignored; 10 real `pnpm-lock` advisories patched via bounded `pnpm-workspace.yaml` overrides (**PR #1367**, merged). Auto-close on next scan.
  - **Supabase advisors:** surfaced → issues **#1369** (SECURITY DEFINER RPCs, `opus`) and **#1370** (leaked-password). RLS-no-policy hits are safe-by-design.
  - **Vercel:** clean — all atc-main/atc-rag deploys READY.
- **CLAUDE.md auto-triage rule** extended with a "Security & quality alerts" subsection (auto-fix-safe / surface-rest) — **PR #1368**, merged.
- MEMORY **D-294** logged; MEMORY-INDEX updated.

## In flight
- Branch `docs/session-d294` (MEMORY / MEMORY-INDEX / SESSION) — PR being opened. Nothing else uncommitted.

## Next step
- Merge the `docs/session-d294` PR (doc-only, audit-exempt).
- Decide on the two pre-existing open PRs (see "Blocked on user").
- Confirm the 38 Dependabot alerts auto-resolved on the next scan.

## Blocked on user
- **Pre-existing open PRs #1359 (pricing tier-code-map refactor) and #1360 (nav sidebar UX)** — both MERGEABLE but BEHIND dev, audit gate unsatisfied (agents never ran). Not from this session. #1360 changes user-facing nav → wants product sign-off before merge. Awaiting decision on whether to update-branch + audit + merge.
- **Issue #1370** — enable Supabase leaked-password protection (dashboard toggle; operator action).
- **Issue #1369** — SECURITY DEFINER RPC `REVOKE EXECUTE` migration needs operator approval (prod-DB).
- Carried from D-293: bump Supabase `refresh_token_reuse_interval` 10s→30s.

## Open questions
- **Playwright E2E fails on every PR** (`authedPage: no storageState found` — missing `TEST_E2E_OWNER_*` / Supabase env in CI). Non-required so it doesn't block merges, but the authed e2e tier never actually runs. Likely intentional (secrets withheld from PR CI) — confirm whether to wire CI secrets or leave as-is. No issue opened pending that call.
