# Session state — last updated 2026-06-10 21:30 UTC

## Standing rule (operator, permanent)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous.

## Just completed
- PR #958 merged: #926 audit timestamp fallback removed, #948 rag 503 = failure, #951 backfill halt alert
- **PR #959 merged — #780 canonical cruise catalog** (MEMORY D-203); 5 migrations applied to dev Supabase
- **Onboarding/UX sprint — all 4 merged** (MEMORY D-204):
  - PR #964 (#961): signup form — sub_host hidden, red required-field validation
  - PR #968 (#960): onboarding post-submission guidance + approval/rejection emails
  - PR #967 (#962): tenant subdomain landing shell (chat default, role nav, hamburger)
  - PR #971 (#963): tenant-editable outgoing email templates; migration applied to dev
- PR #972 merged: MEMORY D-203 + SESSION checkpoint
- Issues closed: #780, #960, #961, #962, #963 (+ #926/#948/#951 earlier)
- Issues opened: #965 (first-sign-in checklist), #966 (rendering-test stack), #969 (platform-tenant roles), #970 (email-template scope extension)

## In flight
- Nothing in flight — clean checkpoint. (Dependabot PR #957 open; its retry workflow owns it.)
- 4 agent worktrees remain under .claude/worktrees/ (branches all merged; safe to clean, left for harness)

## Next step
- Operator review of D-204 product defaults (staff default chat panel; email override replaces AI content; quote-expiry subject copy)
- #969 decision: intended role for platform-tenant customers + prod data check (operator-gated)
- OPERATOR GATE: prod apply of the #780 migrations (×5) and #971 migration (×1)

## Blocked on user
- Prod migration applies (#780 ×5, #971 ×1) — dev is live with all of them
- #969 prod data check + role decision
- Test/staging Supabase project provisioning (#386)
- #899 Vercel Pro upgrade (blocks #894)

## Open questions
- #967 product defaults flagged in its PR body (support-chat choice, staff default, nav mapping, Admin → /settings)
- Port seeding name-match join (ports ↔ port_info_chunks) unvalidated against runtime CruiseMapper name formats
