# Session state — last updated 2026-06-12 10:45 UTC

## Standing rule (operator, permanent)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous.
**Note (D-205):** there is currently ONE Supabase project (mfaknjyqiwcjojukcnea) serving production — MCP applies ARE prod applies. Gate accordingly until #386/#534 split environments.

## Just completed
- PR #1038 merged: assertPlatformRolePage gates on all ~17 remaining admin pages (closes #1002)
- PR #1039 merged: member picker for PAT minting + self-view for all roles (closes #996)
- MEMORY.md entries D-218 and D-219 added

## In flight
- Nothing in flight — clean checkpoint

## Next step
- Remaining open issues: #1010 (vendor-health split-brain), #1025 (audit 69 service-role-tenant hits), #1035 (may need closing — check if PR #1036 auto-closed it)

## Blocked on user
- Nothing

## Open questions
- #1003 (D-201 vs D-170 role-scope alignment review) was surfaced in auto-triage — no fix issued, surface for user if they want to act on it
