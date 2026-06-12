# Session state — last updated 2026-06-12 (post #1025 classification)

## Standing rule (operator, permanent)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous.
**Note (D-205):** there is currently ONE Supabase project (mfaknjyqiwcjojukcnea) serving production — MCP applies ARE prod applies. Gate accordingly until #386/#534 split environments.

## Just completed (this session)
- **PR #1022 merged** (#1016: `runGenerationLoop` extraction; D-213).
- **PR #1026 merged** (#1023: D-091 gate scans SupabaseClient-param modules; D-214).
- **#1025 classification complete** (D-215): all 69 baselined hits read and bucketed. Full table posted as a comment on #1025. Fix issues filed: **#1028** (supervisor path), **#1029** (anon→auth transfer), **#1030** (8-module one-liner batch). Remaining #1025 work = mechanical inline-allows (28) + PLATFORM_TABLES adds (16) + baseline regen.
- Doc PRs #1024, #1027 merged.

## In flight
- Nothing in flight — clean checkpoint (this MEMORY D-215 + SESSION update ships as a doc-only PR immediately after this write).

## Next step
- Operator decides sequencing on the fix issues. Suggested order: **#1028** (chat pipeline, highest exposure) → **#1029** → **#1030** → finish #1025 (annotations + PLATFORM_TABLES + baseline regen; target ≤177 baselined). Per the operator's model discussion: fixes are Sonnet-suitable now that classification is done.

## Blocked on user
- Sequencing/go-ahead on #1028/#1029/#1030 and the #1025 mechanical pass.

## Open questions (carried over)
- #1003: D-201 narrowing — reviewer scope/mechanism (user chose to defer)
- #1008: theming sweep for remaining customer surfaces (deferred from PR #1009)
- Untracked `headroom_memory.db` at repo root (headroom MCP artifact) — left untracked; consider gitignoring in a future PR.
