# Session state — last updated 2026-05-29 ~00:55 UTC

## Just completed

Continuation session: recreated the `atc-main` Supabase DB in the correct region and activated the nightly DB-backed test safety net against it.

- **DB recreation.** `atc-main` recreated in us-east-1. New ref `mfaknjyqiwcjojukcnea`; old mis-regioned ref `ucypskudkmzjphixsshx` deleted; RAG ref `jjznkprbotkqqnuvcost` unchanged. User repointed 4 GitHub Actions test secrets out-of-band (`SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`, `SUPABASE_TEST_SERVICE_KEY`, `SUPABASE_TEST_DB_URL`).
- **PR #385 merged** (squash, branch deleted). `nightly-full-test.yml` now sets `SUPABASE_DB_URL` so the 6 DB-backed suites (rls, proxy, 4 cross-tenant inngest probes) run instead of silently `describe.skip`-ing. Added an idempotent Tier-2 seed step (`scripts/seed-tier2-test.ts`) + `--no-file-parallelism`. Fixed the `_inngest-invoke` harness to model `step.sleepUntil` suspend semantics (future wake → defers; bad wake → throws fail-loud) and added the missing past-`purge_at` branch test. All CI green; both audit subagents clean (one D-091 nit addressed inline).
- **D-112 logged** (in this docs PR): the recreation + the pre-launch prod-as-test exception.
- **Issue #386 opened**: pre-launch follow-up — migrate the nightly DB suites off the prod-serving DB before customer data lands (they invoke destructive global crons).

Verification: 6 DB-backed suites pass against the live seeded DB (44 tests); `pnpm verify` green with `SUPABASE_DB_URL` unset (1920 passed / 61 skipped, lint + slop clean).

## In flight

- **This docs PR** (`docs/session-2026-05-28-d112-nightly-db`): carries MEMORY.md D-112 + this SESSION.md. Being pushed + opened + merged now. If you're reading this and it is NOT merged, finish that first.

## Next step

1. Merge this docs PR once CI passes (then delete the branch).
2. **Switch the model back to Sonnet** — this session ran on Opus. Run `/model claude-sonnet-4-6` (the agent cannot invoke `/model` itself).
3. **Operator follow-ups for the new DB** (Claude cannot do these):
   - Re-point the `supabase-main` MCP server — it still targets the **deleted** ref `ucypskudkmzjphixsshx`. Re-add with new ref `mfaknjyqiwcjojukcnea` (`claude mcp ...`).
   - Production redeploy so the new DB takes effect in prod (Vercel env for `atc-main` must point at the new ref).
   - Optional: `workflow_dispatch` `nightly-full-test` to confirm the DB suites run green end-to-end against the seeded DB (PR CI does not exercise the nightly — it runs only on schedule / manual dispatch).

## Blocked on user

- **Operator follow-ups above** (MCP re-point, prod redeploy) — required for the new DB to be fully live in prod.
- **Issue #386** — needs a dedicated test Supabase project stood up before customer data lands; user routes timing.
- Counsel sign-off (P4 #37–#43) and operator decisions (P4 #48–#55) — unchanged.

## Open questions

- **#366** docs(session) D-106/D-107 — still open, BEHIND. D-106 and D-107 are **not** yet in dev's MEMORY.md (stuck in that PR). Needs an `## Audit` section + update-branch + merge. It edits MEMORY.md near D-105, away from this PR's top-of-file D-112 prepend — likely no conflict, but watch for one.
- **Dependabot #373/#374** — still open from the prior session (merge state UNKNOWN). Prior SESSION expected self-merge; they did not. Check for a `regression-suspected` label or failing required checks.
- **#384** test-scaffolding backlog (`bug`) — tracking issue from this session's sweep; no action pending.
- Phase 2 shift-left (Turbo remote cache), `ai_tool_calls` retention policy, Layer-2 cold-read reviewer — unchanged.

## Carried forward (unchanged)

- BP39: retroactive react-pdf wire-up
- BP31: Haiku tolerable-PII confidence/clarity scorer (cost-deferred — P3 #32)
- BP30: AI behavior eval harness (cost-deferred — P3 #35)
- BP25: PLATFORM_PEPPER offsite + DO-NOT-ROTATE doc (P4 #46)
- BP24: populate `platform_settings.supervisor_slur_deny_list` (P4 #45)
- BP23: populate `port_info_chunks` for 17 ports (P4 #44)
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer (P4 #41)
- §13.9 active vs reactive health probing — operator decision (P4 #48)
- Booking flow Stages 2/3 (passenger details + options)
- persona-addendum-rescreen flush window (4:30→12:30 UTC) — revisit if approved-addendum count grows
