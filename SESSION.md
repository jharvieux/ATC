# Session state — last updated 2026-06-10 21:30 UTC

## Standing rule (operator, permanent)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous.

## Just completed
- Merged PR #949 (#774 cron drain loops), PR #950 (#831 port backfill) → #774/#785/#831 closed
- Design pass (Fable) → PR #952 merged: docs/design/ for #890 (Resend inbound, phased CRM), #712 (admin-only API tokens), #811 (reviewer-only scope), #781 (canonical matcher; alias-table schema change recommended on #780)
- PR #954 merged: CLAUDE.md audit section rewritten for #924 diff-hash binding (timestamp-era guidance removed)
- Cabin-intel probe (operator-approved) → issue #953 opened: CruiseMapper /cabins pages (specs+diagrams, robots-OK) + CruiseDeckPlans.com (crawler-friendly robots, per-cabin pages); Cruise Critic + cruiseline.com ruled out
- #708 re-triaged: BLOCKED on test/staging Supabase provisioning (#386/#563) — supersedes old READY triage
- #821 verified live (RLS on all 8 RAG tables, advisor clean, anon key unused/not client-exposed) and closed — work had shipped in PR #825, issue was never closed

## In flight
Nothing in flight — clean checkpoint

## Next step
**Start #780** (canonical cruise_lines/cruise_ships/ports tables) — per operator, next session opens with #780 and everything it unlocks (#781 → #783, feeds #953). Build notes:
- Use ALIAS TABLES (alias_normalized UNIQUE), NOT aliases text[] — see docs/design/cruise-canonical-normalization.md + comment on #780
- Migration → Opus FIRST AUDIT; OPERATOR GATE on prod apply
- Reconcile ports with existing port_info_chunks (no duplicate store)
Then: #890 Phase 1, #712, #811, #786, #953, #885 (all design-ready or READY)

## Blocked on user
- Test/staging Supabase project provisioning (#386) — unblocks #708/#709/#533/#534 together
- gh auth tokens were revoked server-side twice on 2026-06-10 — if it recurs, check github.com/settings/applications (GitHub CLI OAuth app)

## Open questions
- #948 (vendor-health 503 granularity) + #951 (backfill halt alert): small fixes, no triage comments yet
- #926 (remove audit-check timestamp fallback): NOW UNBLOCKED — zero open PRs, all future audits hash-bound; five-minute workflow edit
- Apify replacement assessment (no issue): keep Apify for live pricing; evaluate agent-credentialed B2B APIs (Traveltek/Revelex-class) if live pricing becomes strategic
