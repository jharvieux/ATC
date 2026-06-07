# Session state — last updated 2026-06-07 ~07:45 UTC

## Just completed
- **Shipped + merged to dev:** PR #829 (#826 chat itinerary lookup + #828a price-deferral scope), PR #830 (#827 future-sailing ports via cruise.json), PR #832 (#828b ballpark general_pricing_ranges). Follow-up #831 filed. MEMORY D-172 logged.
- **ROLLOUT TO PROD executed:**
  - `release/beta045` cut → atc-main prod deployed (Vercel deploy + smoke test passed; benign "auto-merge back to dev" step failure only). Active prod deployment redeployed to `atc-main-6hdaseqip…` so it carries the new env flag.
  - **atc-rag deployed to prod** (manual `vercel deploy --prod`; health 200) — required for #826's RAG-side `fetchItineraryLookupChunks`.
  - **Main migrations applied to prod + verified:** `20260628000005` (inventory kind `sailing_detail`), `20260628000006` (general_pricing_ranges source `estimated`).
  - **`CRUISEMAPPER_DETAIL_FETCH_ENABLED=true`** set on atc-main prod (verified live in the active deployment).
  - **Cleared 250 ship `content_hash`es** (all 251 ships now null) → forces full re-process for the ports backfill.

## In flight
- Nothing in flight from my side. The ports backfill + price derivation run when the user triggers the crons.

## Next step
- **User triggers two Inngest crons:** `refresh-cruisemapper-sailings` (ports backfill — verify `list_details_fetched > 0` in the run summary to confirm the flag is live; long stepped run, ~10k cruise.json fetches at 1/sec, resumable) and `derive-general-price-ranges` (ballpark prices).
- After the backfill: spot-check RAG itineraries now carry `ports_of_call` for future sailings, and chat answers an exact-date itinerary question (e.g. NCL Bliss 2026-10-03).

## Blocked on user
- Trigger the two Inngest crons (cron-only functions — can't be invoked from the CLI/MCP here; use the Inngest dashboard).

## Open questions
- Untracked security-scan artifacts in the working tree (`.agents/`, `.claude/skills/`, `.triage-state/`, `apps/main/src/THREAT_MODEL.md`, `VULN-FINDINGS.*`, `skills-lock.json`, `specs/...copy.txt`) — left untouched; decide whether to commit, gitignore, or discard.
- #831 — automate the port backfill (replace the manual hash-clear) + the residual RAG-chunk-prose price freeze for already-enriched sailings.
