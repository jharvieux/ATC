# Session state — last updated 2026-06-26 UTC

## Just completed

- **PR #1463** (merged) — concierge region/area sailing search + date resolution + BYO tool gating. Fixes a live TA chat session where (1) "next spring" drew a "2025 or 2026?" reply + Australian-season assumption, and (2) a BYO agency got "our inventory system isn't live yet."
  - Date: inject current date into entity-extraction prompt + concierge system prompt; Northern-hemisphere season convention (home-market seasons unless customer asks for destination's local season).
  - Tools: `selectPersonaTools()` withholds `search_host_inventory`/`generate_quote`/`collect_booking_details` from BYO tenants + TA mode; threaded into run-generation-loop (no longer hardcoded PERSONA_TOOLS).
  - Region search: new `region_lookup` end-to-end — contracts, RAG migration **0031** `match_region_itinerary_chunks` RPC (matches region OR departure_port OR ports_of_call via ILIKE-any over a date window; catches the ~96% NULL-region Australia sailings), destination→ports gazetteer, buildRegionLookup wired into retrieve-for-chat. Validated read-only vs prod RAG: 111 Australia Mar–May 2027 sailings (RCL/CEL/NCL + luxury). Also catches US→Australia transpacific via ports_of_call.
  - Refactored 3 structured-lookup handlers into shared helpers (fetchApprovedChunksByIds + shapeStructuredChunks); unified error message.
  - Both audit agents clean (Opus first run). 2 optional NITs, both intentional.
- Earlier this session: PRs #1459, #1456, #1457, #1461 merged; triage closed #1460.

## In flight

Nothing in flight — clean checkpoint.

## Next step

Run auto-triage at next session start.

## Blocked on user

- **Issue #1462** (operator-gated): RAG migration 0031 must be applied to prod via `psql` (SUPABASE_RAG_DB_URL) and `atc-rag` redeployed (`cd apps/rag && vercel deploy --prod --yes`). Merging to dev does NOT deploy RAG. Until then `region_lookup` fails closed in prod (degrades to vector-only). Dev/staging get it via the pipeline.

## Open questions

- Pre-existing migration 20260712000000 (from PR #1437, prior session) still needs prod apply per the pipeline.
- 40 pre-existing `String(err)` egress sites baselined in `scripts/error-message-egress-baseline.txt`. No tracking issue yet.
