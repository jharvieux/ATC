# Session state — last updated 2026-06-04 21:05 UTC

## Just completed

- **PR #704 merged** — onboarding-stale-suspend cron (closes #700). Nightly Inngest cron flips `status='onboarding' → 'suspended'` for tenants stale > 14d, with carve-outs for `is_platform_internal=true` (#699) and `onboarding_stage IN ('review_submitted', 'complete')`. CAS-guarded UPDATE, throws on DB error so Inngest retries. 7 tests verify filter shape, CAS guard, audit-row gating, SELECT/UPDATE error paths. Audits clean.
- **PR #705 merged** — inline Logo + LogoMark SVGs (closes #670). Replaces dual `<img src>` (fetches both light + reverse variants every page load) with inline SVG JSX. Single `<svg>` with shared `<defs>` namespaced via `React.useId()` for multi-instance safety. A11y contract preserved (role/aria-label vs aria-hidden).
- **PR #706 merged** — nightly RAG cost reconciler (closes #692). Cron at 04:30 UTC reads `rag_ai_call_log` from RAG DB and calls atomic `reconcile_rag_cost_row` RPC on main DB. PL/pgSQL function does ledger-INSERT (PK on `rag_log_id` for retry-safe dedup) + `increment_tenant_ai_cost` in one TX. New migration includes explicit no-user RLS deny policies per §30.8 lint gate. 9 tests including keyset-pagination tuple-compare shape + BIGINT `.toString()` round-trip. See D-153.
- **PR #707 merged** — Logo + LogoMark sizes bumped 1.75× across all 6 call sites (per user request). for-agencies nav row grew from `h-16` to `h-20` to keep margins around the larger 49px logo. Audits clean.
- **#384 closed** — split into **#708** (Cross-Tenant Probe fixtures, blocked on #386) and **#709** (E2E fixme'd specs, blocked on #386). Issue 2 was already fixed by PR #632; only Item 1 + Item 3 had residual work and both depend on the test DB harness.

## In flight

Nothing in flight — clean checkpoint. On `dev`, no uncommitted code changes (SESSION.md + MEMORY.md edits being committed alongside this update).

## Next step

Next session should pick a tractable issue. Current open-issue snapshot:

- **Needs #386 first**: #708, #709 (test DB harness must land before either can move).
- **Needs your input**: #386 (Supabase project provisioning — a dashboard task).
- **Operator decisions blocking**: #500, #473, #430, #429, #428.
- **External state blocked**: #534 (DB_URL secret), #533 (staging DB), #659 / #660 (GitHub repo settings UI).
- **Tracking epics, not actionable**: #427, #426, #444.

## Blocked on user

- **#386** — provisioning a dedicated test Supabase project. Once that's done, #708 and #709 become tractable code work.
- **MEMORY D-152 cross-reference inaccuracy** — still flagged. References D-148/D-149 as "billing-gate-semantics" and D-151 as `is_platform_internal` introduction; both wrong (D-148 is UX redesign, D-149 is follow-up-issue rule, D-151 is RAG env var canonicalization). Hook is append-only; fix path is a D-153 acknowledgment ONLY with explicit user permission. **Update**: D-153 was used for the RAG reconciler arch decision (this session); a D-154+ entry is the path if you want to acknowledge the D-152 errata.

## Open questions

- Should the RAG cost reconciler's lookback window scale with cron frequency, or is the 25h fixed value fine for a daily run? Currently hardcoded; test asserts 25h. Not blocking.
- Should `rag_cost_reconcile_ledger` have a TTL purge cron to bound growth? Index on `reconciled_at` exists for it. Not blocking; only a concern after embedding traffic stabilizes.
- Model: this session ran on Opus 4.7 throughout. Per CLAUDE.md end-of-session protocol, the model should be switched back to Sonnet for the next session via `/model claude-sonnet-4-6`.
