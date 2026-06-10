# Session state — last updated 2026-06-10 23:55 UTC

## Standing rule (operator, permanent)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous.
**Note (D-205):** there is currently ONE Supabase project (mfaknjyqiwcjojukcnea) serving production — MCP applies ARE prod applies. Gate accordingly until #386/#534 split environments.

## Just completed
- #780 cruise catalog (PR #959) + onboarding/UX sprint (PRs #964/#967/#968/#971) — see D-203/D-204
- Operator directives round 2 (D-205), all merged:
  - PR #977: staff land in TA-mode concierge at tenant root
  - PR #978: viewer-role fix + backfill EXECUTED on live project (2 customers demoted, operator kept)
  - PR #980: {{ai_content}} editor placeholders + marketing-grade default templates; group-reminder CAN-SPAM footer fix
  - PR #981: dependabot-update-branch cron (GitHub App token; GH_APP_ID/GH_APP_PRIVATE_KEY secrets added)
  - Dependabot labels created (dependencies, automerge-candidate); #957 superseded by #976 (merged)
- All 6 migrations confirmed live on the production-serving project
- Issues closed today: #780, #926, #948, #951, #960–#963, #969, #974, #975

## In flight
- Nothing in flight — clean checkpoint. (This MEMORY/SESSION chore PR is the last item.)
- Agent worktrees under .claude/worktrees/ from merged branches — safe to clean

## Next step
- Operator: pick the #966 testing approach (lean: add jsdom+RTL as dev-deps)
- Then any of the Sonnet-suitable follow-ups: #965 (first-sign-in checklist), #970 (remaining email types), #979 (RSVP CTA — needs invite landing page first)
- Optional sanity: trigger dependabot-update-branch via workflow_dispatch to confirm a clean no-op run

## Blocked on user
- #966 test-approach decision
- #899 Vercel Pro upgrade (blocks #894)
- Test/staging Supabase provisioning (#386) + deploy.yml prod-migration step (#534) — reconcile SUPABASE_PROD_DB_URL secret with the single-project reality (D-205)

## Open questions
- Port seeding name-match join (ports ↔ port_info_chunks) unvalidated against runtime CruiseMapper name formats
- Quote-expiry subject copy ("Your estimate for your cruise has expired") — operator may want a reword
