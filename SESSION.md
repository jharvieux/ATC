# Session state — last updated 2026-07-16 14:45 CDT (persona prompt truth pass)

## Just completed

**D-359 persona prompt truth pass merged (PR #1965).** All six travel-persona base-blocks rebuilt: character cores kept faithful to the Agent Backstories docx; every checkable domain claim fact-checked by six parallel research agents against primary sources (July 2026) and corrected — headline fixes: St. Maarten is a dock port, Glacier Bay has 7 tidewater glaciers with line-specific access, Regent no longer bundles air, Silversea's Door-to-Door fares retired, Seabourn is a 5-ship fleet, Disney runs 8 ships, Anan is a Wrangell black-bear site, Norwegian Aqua has 42 accessible staterooms, Nennella/Pinotxo both moved. 2025-2026 industry state added (port caps, Greek cruise tax, private-island arms race, new luxury entrants, Mendenhall recession). customer_bio + AGENT_CATALOG bios fixed (old POC copy contradicted the backstories). New code-side `KNOWLEDGE_FRESHNESS_BLOCK` on all travel personas: retrieved data beats memory, never state prices/availability from memory. Research record: `docs/specs/persona-fact-check-2026-07.md`. MEMORY D-359 logged.

Audits: first run Opus×2 (migration risk trigger) — d091 clean, pre-pr 2 warnings (unearned export/test gap) → fixed with explicit freshness-block assertions → Sonnet×2 re-audit clean → gate green → squash-merged with explicit subject/body (no closing keywords; none intended).

## In flight

Nothing in flight — clean checkpoint. (This docs PR is the last item.)

## Next step

- Migration `20260722000024_persona_prompt_truth_pass.sql` applies to the beta/test DB via the dev-merge pipeline automatically. **Prod apply is release-gated as usual** — the live prod personas keep the old (erroneous) prompts until the next release cut.
- Optional operator verification once beta deploys: run the docx test conversations (e.g., ask Marco about 8 hours in Santorini; ask Maya about power-wheelchair planning; ask Priya Haven vs Retreat) and confirm the personas hedge on prices/availability and cite retrieved data.

## Blocked on user

- **#1523** — enable leaked-password protection (Supabase dashboard).
- **#1740** — 2 of 3 errors need prod DDL (`review_submitted_at` ledger/DDL divergence can't self-heal; `attribution_rollup` MV refresh).
- **#1926** — `prod-drift-check` + `contracts-canary` failing daily.
- **#1950** — is `reconcile-statement-automated.ts` in scope for perf work?
- **Prod is ~170+ commits behind dev**; release cut is a scheduling call (blocks #1843 strict flip, and now also the persona-prompt prod refresh).
- Carried over: #1911, #1868–#1870, #444 sub-issues (#1257/#1260 operator, #1258/#1259 attorney via #427, #1262 launch gate).

## Open questions

- `deploy.yml:415` skips the RLS drift step on `dev` pushes — dev can't catch out-of-band drift until it blocks every PR at once. Worth a decision.
- #1912 reopened — durable fix is gating the reset effect on an actual type change (PR #1943 only narrowed the flake window).
- Stale orphan shim `apps/main/node_modules/.bin/tsx` (May 20, points at removed tsx@4.22.3) shadows the root shim for `pnpm exec tsx` from apps/main — harmless to delete locally; noting in case another session hits "Cannot find module tsx@4.22.3".
- Persona facts have a July-2026 vintage — `docs/specs/persona-fact-check-2026-07.md` lists which categories to re-verify on the next refresh.
