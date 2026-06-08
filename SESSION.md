# Session state — last updated 2026-06-07 ~23:30 UTC

## Just completed
- **#850 diagnosed:** the concierge ignores ship+date itinerary queries (e.g. "Bliss on 10/3/26") NOT because of missing data — the data is perfect (RAG `itineraries` has Norwegian Bliss 2026-10-03, Seattle, 7-night Alaska, 5 ports, $929, day_by_day + embedded chunk; 0 unembedded chunks). Root cause: **entity extraction is silently failing in prod** (0 `entity_extraction` calls in `ai_call_log` over 48h despite running every turn) → #826's lookup never fires. The error was swallowed with no log (that's why it was invisible). See MEMORY **D-177** (incl. my two corrected mis-diagnoses — key + Haiku model both test FINE with the **root** `.env.local` key; the real call-failure cause is still hidden until the loud-fix deploys).
- **PR1 #852 (loud failures) — MERGED to dev.** `extractEntities` + `instrumentedClaudeCall` + `parseEntities` now log failures loudly. Foundation of #851 + the unblock for finding #850's real cause.
- **#851 model-resilience initiative filed**, operator policy "attempt latest, fall back on issues." PR2 groundwork done: model-id surface mapped (~30 files); verified the undated alias `claude-haiku-4-5` works (200) so attempt-latest-via-alias is feasible.
- Earlier today: sailing-cron timeout fix (beta047, live; backfill ~236/251, embeddings 100% caught up); cross-tenant cluster #845 + webhook #848 merged to dev.

## In flight
- **PR2 (#851 model resilience)** — designed + groundwork done, NOT yet built. Nothing uncommitted (this checkpoint aside).

## Next step
- **Build PR2:** central `lib/ai/models.ts` config (single source of truth) + per-purpose ordered chain `[latest-alias → pinned-fallback]` + circuit-breaker auto-fallback in `instrumentedClaudeCall` + undated aliases for internal helpers + **add alias entries to `lib/ai/pricing.ts`** (so cost-tracking doesn't zero out). Then **PR3:** canary (deploy-gate + daily cron + CI vs `GET /v1/models`).
- **Cut beta048** (batched: #845 + #848 + #852 + the rest of #851) → then re-run the Bliss query and read the now-visible entity-extraction error to fix the actual #850 cause.

## Blocked on user
- **beta048 timing** — proposed: batch everything into one prod push once PR2/PR3 land (operator can request sooner).
- Confirm the PR2 "latest" defaults (auto-snapshot within a generation via alias; new generation = deliberate eval-gated bump; auto-fallback on availability errors only). Stated; redirect if wanted.
- **Add `INNGEST_API_KEY`** repo secret (still unset).

## Open questions
- The real entity-extraction call-failure cause (#850) — hidden until #852 is in prod; key + model are ruled out, so it's in the wrapper's pre-call path or params.
- #846 (cancel `payout_records` CAS gap); the ~20 other open 2026-06-05 scan findings (#717–#750).
