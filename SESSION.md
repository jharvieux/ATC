# Session state — last updated 2026-06-10 20:45 CDT

## Standing rule (operator, permanent)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous.
**Note (D-205):** there is currently ONE Supabase project (mfaknjyqiwcjojukcnea) serving production — MCP applies ARE prod applies. Gate accordingly until #386/#534 split environments.

## Just completed
- Merged PR #989 (fix #819): ferry skip stamping + deck parser redirect fix
- Merged PR #990 (#781 Phase 2 Step 1): cruise FK expand migration (renamed 20260611→20260701 to fix sort-order blocker)
- Opened PR #991 (§953 Phase A): CruiseMapper cabin-intel parser + ingest integration
  - cabin-parser.ts + 12 tests (Norwegian Prima live fixture, 2026-06-10)
  - Migration 20260701000002: adds 'cabin' kind + 'not_cruise_ship' status to inventory constraints (fixes #819 stampFerrySkips CHECK gap)
  - discoverCabinUrls, recordCabinImage, cabin processing loop in refresh-cruisemapper-static

## In flight
- PR #991 (feature/953-cabin-intel-parser): CI running; Opus audit agents running in background

## Next step
- Wait for PR #991 audits → fix any findings → merge
- After #991: #781 Phase 2 Step 2 — canonical matcher (free-text→FK via alias tables) + backfill + reader repointing. Separate PR.
- #781 Phase 2 Step 3: contract (drop free-text columns). Separate PR.
- #953 Phase B: CruiseDeckPlans.com. Read their ToS before building.

## Blocked on user
- Nothing

## Open questions
- Ferry rows stuck at parse_failed in prod (4 rows: Stena-Estrid, Havila-Pollux, Superfast-XI, Galicia): will self-heal on next sailing ingest after #991 deploys. Operator can trigger via Inngest dashboard sooner.
- #781 Phase 2 Step 2 canonical matcher design: alias tables exist (cruise_line_aliases, cruise_ship_aliases). Normalize strategy: lowercase, strip punctuation, strip "cruise line"/"cruises"/"line" suffixes, then lookup.
