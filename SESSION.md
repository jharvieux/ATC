# Session state — last updated 2026-06-17 07:00 UTC

## Just completed
- PR #1201 (feature/fix-oauth-subdomain-redirect) — merged. OAuth post-login redirect now sends tenant-subdomain users back to their subdomain after Supabase's platform-domain callback. Included security fix for open-redirect via path-injection on raw tenant_host string.
- All audit agents (D-091 + pre-pr-reviewer) completed clean on both PRs.
- PR #1201 `pr-audit-section-check` passed, PR merged and branch deleted.

## In flight
- PR #1199 (feature/role-aware-site-header-menu) — CI running after update-branch (PR #1201 merge moved dev ahead). All checks expected to pass; audit hash unchanged by the merge commit. Waiting for CLEAN state to merge.

## Next step
- Wait for CI on PR #1199 to complete (background task watching).
- Merge PR #1199 once CLEAN.
- Update MEMORY.md with session decisions.
- End-of-session protocol.

## Blocked on user
- Nothing

## Open questions
- Issue #1200 (CRM pages missing left-rail PanelLeft conversation panel) — deferred from PR #1199, tracked in the issue.
- `release/beta063`, `beta064`, `beta065` stuck failed on remote — protected branches. User can delete manually via GitHub if desired.
