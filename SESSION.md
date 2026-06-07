# Session state — last updated 2026-06-07 ~20:15 UTC

## Just completed
- **Stripe webhook dedup fix (#719) — MERGED to dev via #848.** Reviewed @sravan27's fork PR #790, found two gaps, filled them (concurrency age-guard so an in-flight dedup row isn't deleted; reconcile cron now deletes stalled rows, was alert-only; shared `STALE_WEBHOOK_PROCESSING_MS`), took it through the gate. The fork PR couldn't pass branch protection (secret-gated required checks skip on forks), so **re-homed the commits to an origin branch (#848)** where all checks ran green + merged. #790 closed/superseded (author credited). See MEMORY **D-176** (incl. the reusable fork-PR-CI lesson).
- (Earlier today) Sailing-cron timeout fix → **deployed beta047** (D-174); cross-tenant service-role cluster (#845) → **merged to dev, deploy held** (D-175).

## In flight
- Nothing uncommitted (this checkpoint aside) — clean on dev.

## Next step
- **Cut beta048** when ready — it carries BOTH undeployed dev items to prod: the **#845 cross-tenant cluster** (closes the live #715 HIGH leak) **and** the **#848 webhook dedup fix**. Code-only, no migration.
- Re-trigger `refresh-cruisemapper-sailings` if it stopped with `ships_remaining` > 0 (it resumes; was ~134/251 and climbing as of 18:20 UTC).

## Blocked on user
- **beta048 deploy** decision (held) — #715 stays exploitable in prod until then; #848 webhook fix also waits.
- **Add `INNGEST_API_KEY`** repo secret (still unset) — deploy-time Inngest sync skips + `derive-general-price-ranges` won't auto-register without it.

## Open questions
- The other ~20 open 2026-06-05 scan findings (#717–#750) — future fix batches (timing-attack HMACs, prompt-injection, file-type/magic-bytes, resource-exhaustion, the remaining Stripe webhook items, etc.).
- #846 — pre-existing cancel `payout_records` CAS row-count gap (filed from the #845 audit).
- d091 baseline (`scripts/d091-baseline.txt`) lists now-fixed service-role-tenant hits — prune when convenient (gate only fails on NEW).
