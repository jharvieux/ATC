# Session state — last updated 2026-06-06 21:10 UTC

## Just completed
- **#813 (last-superadmin TOCTOU)** — PR #814 merged. Advisory-locked SECURITY DEFINER RPCs; migration `20260628000004`.
- **Process retrospective** (open + past-week-closed issues) → filed **#815** (mechanical D-091 CI lints), **#816** (close `pnpm verify` vs CI gap — add `lint:migrations`; RAG tests #792), **#817** (strengthen d091-reviewer: changed-constant → enumerate dependents).
- **#811 (per-role admin enforcement)** — scoped + **QUEUED for a focused session** (your call; ~50-file all-or-nothing security rollout). Plan + confirmed area→role policy in **MEMORY D-170**; tasks #35–38. (The 2 "ungated" routes were a false alarm — they're service-to-service `MAIN_APP_ADMIN_API_KEY` bearer-gated.)
- Whole session, all merged to dev: #799, #800/#803, #441/#804, RAG flush #805/#806/#807/#808/#810, #809, role-mgmt #812, #813. atc-rag deployed twice (RAG flush fixes live).

## In flight
- Nothing in flight — clean checkpoint, on dev. (#811 is planned only — no code yet.)

## Next step
- **#811** — implement per-role admin enforcement (tasks #35–38; policy = D-170 area map). ~50 files, all-or-nothing; do as a focused session.
- **Cut an atc-main beta** to ship the dev-only main-app work to prod: **#803 (#800), #804 (#441), #812 (role mgmt), #814 (#813)**. Migration order at deploy:
  1. Deploy the code (beta gate).
  2. `20260628000002` (users.role default → viewer) — **CODE-FIRST** (D-166).
  3. `20260628000003` + `20260628000004` (admin RPCs) — additive, anytime.
- After deploy: **#1** Booking cleanup; **#3** test agency.

## Blocked on user
- **beta cut** (atc-main → prod) — your call.
- **#1 Booking cleanup** (delete vs deactivate the bad owner rows) — confirm before the prod data change.

## Open questions / follow-ups
- Queued: #811 (per-role enforcement). Process: #815/#816/#817. Other: #807 (bulk-flip test), #785/#786 (vendor health), #780/#781/#783 (cruise-line DB), #774, #792, #715–#752 (security backlog).
- Watch: RAG embedding queue draining (OpenAI Batch API latency, D-168).
