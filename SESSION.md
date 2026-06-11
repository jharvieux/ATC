# Session state — last updated 2026-06-10 22:30 CDT

## Standing rule (operator, permanent)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous.
**Note (D-205):** there is currently ONE Supabase project (mfaknjyqiwcjojukcnea) serving production — MCP applies ARE prod applies. Gate accordingly until #386/#534 split environments.

## Just completed
- Merged PR #989 (fix #819): ferry skip stamping + deck parser redirect fix
- Merged PR #990 (#781 Phase 2 Step 1): cruise FK expand migration (renamed 20260611→20260701 to fix sort-order blocker)
- Merged PR #991 (§953 Phase A): CruiseMapper cabin-intel parser + ingest integration
  - cabin-parser.ts + 12 tests (Norwegian Prima live fixture, 2026-06-10)
  - image-asset-recorder.test.ts + 4 tests (kind selection, entity-id, allowlist)
  - Migration 20260701000002: adds 'cabin' kind + 'not_cruise_ship' status to inventory constraints
  - discoverCabinUrls, recordCabinImage, cabin processing loop in refresh-cruisemapper-static
- Commented on issue #953 noting Phase A complete

## In flight
Nothing in flight — clean checkpoint.

## Next step
- **#781 Phase 2 Step 2**: canonical matcher (free-text → FK via alias tables `cruise_line_aliases` / `cruise_ship_aliases`) + backfill migration + reader repointing. Separate PR.
  - Normalize strategy: lowercase, strip punctuation, strip "cruise line"/"cruises"/"line" suffixes, then lookup alias tables.
- **#781 Phase 2 Step 3**: contract (drop free-text columns). Separate PR, after Step 2.
- **#953 Phase B**: CruiseDeckPlans.com integration. Read their ToS before building.

## Blocked on user
- Nothing

## Open questions
- Ferry rows stuck at parse_failed in prod (4 rows: Stena-Estrid, Havila-Pollux, Superfast-XI, Galicia): will self-heal on next sailing ingest after #991 deploys. Operator can trigger sooner via Inngest dashboard — see #822.
- **Constraint drop-recreate blast radius rule**: when adding a new CHECK value via DROP+ADD constraint, ALWAYS grep for prior migrations that modified the same constraint (`grep -l "kind_check" migrations/`) and include ALL existing values from ALL prior migrations. (Bit us on PR #991 — omitted 'sailing_detail' from 20260628000005.)
- #781 Phase 2 Step 2 canonical matcher: alias tables exist. Normalize: lowercase, strip punctuation, strip "cruise line"/"cruises"/"line" suffixes, then lookup cruise_line_aliases / cruise_ship_aliases.
