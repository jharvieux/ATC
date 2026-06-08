# Session state — last updated 2026-06-07 (opus-4-8 adopted + beta048 live)

## Just completed
- **Adopted `claude-opus-4-8`** (#858, merged to dev). Opus tier chain is now `[claude-opus-4-8 → claude-opus-4-7]` via #851's attempt-latest machinery; ~30 callers unchanged (both ids map to the opus tier); `DOWNGRADE_MAP` covers both; placeholder pricing = 4-7 with `TODO(#857)`. Both audits clean (Sonnet ×2). MEMORY D-179.
- **Created #857** — operator follow-up checklist: verify opus-4-8 list price, eval 4-8 vs 4-7, add `INNGEST_API_KEY` repo secret, add `ANTHROPIC_API_KEY` in CI, decide on untracked security-scan artifacts.
- **beta048 is LIVE in prod.** Deploy + smoke + the new "Verify configured models are live (#851)" deploy-gate + "Sync Inngest app (#835)" all green. Only red = "Auto-merge release branch back to dev" (the known benign no-op — release was cut from dev, nothing new to merge back; I don't touch release/* merges). beta048 batched #845 (cross-tenant cluster) + #848 (webhook dedup) + #852 (loud AI-call failures) + #854/#855 (#851 fallback + canary).

## In flight
- This checkpoint only: MEMORY.md (D-179) + SESSION.md on branch `chore/session-checkpoint-opus-4-8`, about to be doc-only PR'd into dev. No code in flight. dev is clean.

## Next step
- Merge this doc-only checkpoint PR.
- Then await user. The substantive next move is **#850**: now that beta048's loud-fix (#852) is in prod, re-run the concierge "itinerary for the bliss on 10/3/26" query → read the now-visible `entity_extraction` failure in `ai_call_log` / logs → fix the actual cause (key + Haiku model already ruled out via the ROOT `.env.local` key; the real cause is still hidden until the loud-fix is exercised).

## Blocked on user
- **#857 operator actions** (none block code; the app degrades gracefully without them):
  - Verify `claude-opus-4-8` list price → update `pricing.ts` (currently a 4-7 placeholder).
  - Eval opus-4-8 vs 4-7 on key flows (quality/cost are eval-gated, not auto-detected).
  - Add `INNGEST_API_KEY` repo secret → registers the new `model-canary` cron (+ the pending `derive-general-price-ranges`).
  - Add `ANTHROPIC_API_KEY` in CI → the model-resilience deploy-gate pings for real (currently guarded-skips).

## Open questions
- #850's real entity-extraction failure cause is STILL unknown until someone re-runs the Bliss query against beta048 and reads the loud error. Everything is staged to diagnose it the moment that happens.
- Pre-existing open scan findings not touched this session: #846 (cancel `payout_records` CAS gap) + the ~20 other 2026-06-05 scan items (#717–#750).
- Untracked working-tree artifacts from a prior security scan (`apps/main/src/THREAT_MODEL.md`, `VULN-FINDINGS.{json,md}`, `.triage-state/`, `.agents/`, `skills-lock.json`, a stray `specs/...copy.txt`) — not committed, not from this session; surface to user before any cleanup.
