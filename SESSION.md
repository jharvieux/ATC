# Session state — last updated 2026-06-08 ~00:30 UTC

## Just completed
- **#851 model-resilience COMPLETE** — all 3 layers merged to dev (see MEMORY **D-178**):
  - **#852** loud AI-call failures (no more silent swallow — the root of #850's invisibility).
  - **#854** central `lib/ai/models.ts` + attempt-latest model chain + circuit-breaker runtime fallback (bills the served model).
  - **#855** proactive canary: daily `model-canary` cron + `deploy.yml` gate (`scripts/check-models-live.ts`).
- **#850 diagnosed** (not closed): the concierge ignores ship+date itinerary queries because entity extraction is silently failing in prod — NOT a data gap (the Bliss 10/3/26 itinerary is present + embedded). Key + Haiku model both verified fine (via the ROOT `.env.local` key). Actual call-failure cause still hidden until #852 deploys.
- Earlier today: sailing-cron timeout fix (beta047, backfill ~done, embeddings 100% caught up); cross-tenant cluster #845; webhook fix #848 (re-homed from fork #790). D-174/175/176/177/178 logged.

## In flight
- Nothing uncommitted (this checkpoint aside) — clean on dev.

## Next step
- **Cut beta048** — batched prod push of #845 + #848 + #852 + #854 + #855. After it deploys, re-run the Bliss query → read the now-visible entity-extraction error → fix #850's real cause.

## Blocked on user
- **beta048 deploy** decision (batched, held).
- **`INNGEST_API_KEY`** repo secret → registers the new `model-canary` cron AND the pending `derive-general-price-ranges` cron (both won't run on their crons until set + resynced).
- **`ANTHROPIC_API_KEY` in CI** → activates the deploy-gate model canary (else it safely skips).
- **Adopt `claude-opus-4-8`?** Newer than our pinned 4.7 — deliberate eval-gated bump (the canary surfaced it).

## Open questions
- #850's actual entity-extraction call-failure cause — surfaces once #852 is in prod (key + model are ruled out, so it's in the wrapper's pre-call path or params).
- #846 (cancel `payout_records` CAS gap); the ~20 other open 2026-06-05 scan findings (#717–#750).
