# Session state — last updated 2026-07-07 13:20 CT

## Just completed
- **PR #1685 merged** (D-324): repeatable help-doc screenshot pipeline — manifest (`scripts/help-screenshots/manifest.ts`), Playwright capture with DOM-injected annotations + magic-link session mint + live-verified wrong-state-render guard (`capture.ts`, `render-guard.ts`), `check:help-screenshots` drift gate (in `verify` + CI Guards, unit-tested ×16 cases across two files), runbook `docs/runbooks/help-docs.md`. Survived 4 audit rounds; every finding fixed in-branch.
- **Demo tenant live on beta** (partial #1686): "Harbor Light Travel", slug `demo`, tenant id `dd000000-0000-4000-8000-000000000001`, byo_professional, active, subscription_status=active. Owner Dana Whitfield (`jharvieux+atc-demo@gmail.com`, creds in operator `.env.local` as `HELP_SHOTS_EMAIL/PASSWORD` — note password logins are DISABLED on beta; capture mints sessions via GoTrue admin magic-link using `SUPABASE_SERVICE_ROLE_KEY`). Seeded: 2 extra team members (Maya Castillo/agent, Ben Osei/viewer), 6 contacts, 5 quotes + quote_options (draft/sent/viewed/converted/declined), 2 bookings + passengers (confirmed w/ fare_breakdown deposit schedule, sailed), 3 conversations (1 escalated) + 5 messages, tenant_branding row, 4 audit_log rows. Verified rendering live: TA dashboard, quotes list, settings/branding all look like a real agency.
- Filed #1686 (finish demo-tenant content), #1687 (30 captures + doc edits; includes consent-banner `isVisible` note), #1688 (PDF/Word export image resolution).

## In flight
- Nothing uncommitted — working tree clean, `dev` at `ed8a7747`, feature branch deleted.

## Next step
- Execute #1686 remainder + #1687: seed the still-missing screens (group + forum, RAG review-queue item, held-for-review message, usage counters/ai_call_log, CRM import row, personas state), then add ~30 `Shot` entries to the manifest, run `pnpm help:screenshots` (env in runbook), replace all `[Screenshot: ...]` placeholders with `![alt](/help/<slug>/<id>.png)`, land as 1-2 PRs. Operator chose "tooling + all 30 shots" scope (D-324) — the backfill is committed work, not optional.
- Then #1688 (verify PDF/DOCX export renders the images inside the Inngest worker).

## Blocked on user
- Nothing.
- Carried from before: `feature/sweep-money-1606` remote branch still holds orphaned doc changes from the cancelled #1638 batch — operator to decide salvage vs let stale.

## Open questions
- GitGuardian check fails on PR #1685-era commits flagging the `password` variable name in capture.ts (not a secret; Secret Scan passes; GitGuardian is not a required check). If it keeps tripping on future PRs touching that file, dismiss the incident in the GitGuardian dashboard.
- 13 stale locked agent worktrees under `.claude/worktrees/` (carried) — remove if the harness didn't release them.
- Carried: #1658 JPY formatCents product decision.
