# Session state — last updated 2026-05-27 ~07:30 UTC

## Just completed

Continuation of the D-091 audit follow-up. From the prior session's "8 open PRs" merge train, all 8 have landed plus several new ones from this session.

### Merged into dev since last SESSION.md
- **#285** per-action assertPermission in forums message route (D-091 R2 Pattern 9)
- **#286** dedup email-path imports on Gmail Pub/Sub redelivery (D-091 R2 Pattern 10)
- **#287** consent renewal explicit length check (D-091 R3 Pattern 18)
- **#288** apps/rag eslint-plugin-atc + safeAwait migration (D-094)
- **#289** zero-row CAS guards on payout-records mutations (D-091 R3 Pattern 7)
- **#290** bookings stuck-submitting reconcile cron (D-091 R3 #50/#51 follow-up)
- **#291** payouts-execute-transfer error-injection probe
- **#292** Tier 1 Inngest crons + stuck-submitting reconcile probes
- **#293** RAG feedback webhook + apps/rag probe wiring (D-091 Tier 2)
- **#294** Pattern 15 batch 1 — system/user split + delimited tags (extract-memory, forum-moderation)
- **#298** Pattern 15 batch 2 — `<document>` / `<content>` / `<message>` tags on 4 more Haiku call sites
- **#299** Pattern 5 — tenant_id filter on service-role mutations across 6 route files
- **#301** @types/big.js 6 → 7 (type-only; aligns with runtime big.js@7)
- **#303** D-097 help-AI persists user+assistant turns to messages table (re-open of #297/#300; originals hit a GitHub PR-state desync bug after rebase)
- **#304** @types/node 22 → 24 (matches `engines.node` and Vercel default LTS)
- **#305** TypeScript 5.7 → 6.0 (one new ambient declaration in `apps/main/src/globals.d.ts` for `*.css` side-effect imports — that was the only TS 6 breakage in our tree)

### Open PRs at session end (awaiting CI / merge)
- **#306** docs (this PR — SESSION.md + MEMORY.md update)

### Carried-forward (deferred — bigger migrations, ≥1 evening each)
- ESLint 8 → 10 (flat config rewrite)
- Tailwind 3 → 4 (CSS-first config; complete build-pipeline change)
- Vitest 1 → 4 (changes many APIs; blocks @stryker-mutator/* 9 which peer-requires vitest ≥2)
- eslint-config-next 14 → 16 (tied to Next.js bump)
- @typescript-eslint/* 7 → 8 (requires ESLint 9+)
- @stryker-mutator/{core,vitest-runner} 8 → 9 (blocked behind vitest 2+)

## In flight

Nothing in flight after #306 merges — clean checkpoint.

### GitHub backend caveat hit tonight
- Some PRs got into a stuck state where the merge endpoint returned HTTP 500 with empty body after rebases. GitHub's PR head_sha cache desynced from the actual branch SHA. The workaround: push the rebased commit to a NEW branch name and open a fresh PR. Original PR can be closed; the work transfers cleanly.
- Squash-merge endpoint returned 500 for a while tonight; falling back to `merge_method=merge` works. We can squash via the UI later if a clean linear history matters.

## Next step

1. Start one of the deferred Dependabot majors. Recommended order:
   - **Vitest 1 → 4** first (unlocks @stryker-mutator/* 9 and @typescript-eslint 8 paths).
   - **Tailwind 3 → 4** next (independent build-config rewrite; CSS-first).
   - **ESLint 8 → 10** last (flat-config migration; cascades to eslint-config-next 14 → 16 and @typescript-eslint 7 → 8).
   Each warrants ~1 evening of focused work per the operator's earlier direction.
2. If GitHub backend is healthy again, switch back to squash merges for new PRs.

## Blocked on user
- Nothing.

## Open questions
- The GitHub PR-head-desync bug consumed real time tonight — if it recurs systematically, consider opening a support ticket. Not actionable code-side.
- Per-major Dependabot strategy is working but slow. Tailwind / Vitest / ESLint each warrant a full evening of focused work.

## Decisions logged tonight
- **D-097** (PR #297/#300/#303): Help-AI persists user + assistant turns to `messages` table (reusing existing schema rather than adding a `help_messages` table). Help-AI turns count toward customer chat metrics via `incrementChatMessages`. Admin-source sessions get a `conversations` row created lazily on first turn.

## Carried forward (unchanged from prior session)

- BP39 follow-up: retroactive react-pdf wire-up
- BP31: Haiku tolerable-PII redaction confidence/clarity scorer (cost-deferred)
- BP30: AI behavior eval harness (cost-deferred)
- BP25: PLATFORM_PEPPER offsite storage + DO-NOT-ROTATE doc
- BP24: populate `platform_settings.supervisor_slur_deny_list`
- BP23: populate `port_info_chunks` content for 17 ports
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer
- §13.9 active vs reactive health probing — operator decision
- §20.4 / §38.8 / §38.8.1 / §39.5 — customer-facing AI chat panels build (~2 days, browser testing)
