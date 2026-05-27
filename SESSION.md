# Session state — last updated 2026-05-27 ~08:30 UTC

## Just completed

Continuation of the D-091 audit follow-up + the Dependabot per-major bump
backlog. Tonight landed 18 PRs total: 13 D-091 follow-ups + 5 Dependabot
majors + 1 Vercel build fix.

### Merged into dev this session
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
- **#303** D-097 help-AI persists user+assistant turns to messages table (re-open of #297/#300)
- **#304** @types/node 22 → 24 (matches `engines.node` and Vercel default LTS)
- **#305** TypeScript 5.7 → 6.0 (one ambient `*.css` declaration was the only breakage)
- **#307** RAG inngest route: skip INNGEST_SIGNING_KEY throw during Next.js build phase (unblocks Vercel build)
- **#308** vitest 1.6 → 4.1 + @stryker-mutator 8.7 → 9.6 + vite 7 (no source changes; 1702 tests still pass)
- **#309** tailwindcss 3.4 → 4.3 (kept JS config via `@config` directive; build + tests + lint green; manual UI smoke recommended before prod)

### Open PRs at session end
- **#310** docs (this PR — SESSION.md update)

### Dependabot majors still deferred — they cascade into a Next.js bump
- **eslint 8 → 10** — `eslint-config-next@16` peer-requires `eslint ≥9`, and `eslint-config-next` for `eslint@9+` requires **Next.js 15+**. We're on 14.2.35. This is unavoidably a Next.js 14 → 15 (or 16) framework migration — middleware rewrites, async dynamic routes, caching defaults, etc.
- **@typescript-eslint/* 7 → 8** — peer-requires `eslint@9+`, so blocked behind the same cascade.
- **eslint-config-next 14 → 16** — blocked behind the same cascade.

Recommended sequencing for a future session: Next.js 14 → 15 first (own PR, careful migration with manual smoke), then ESLint 8 → 9 + flat-config conversion, then @typescript-eslint 7 → 8 and eslint-config-next 14 → 16 ride along.

## In flight

Nothing in flight after #310 merges — clean checkpoint.

### GitHub backend caveat hit tonight
- Some PRs got into a stuck state where the merge endpoint returned HTTP 500 with empty body after rebases. GitHub's PR head_sha cache desynced from the actual branch SHA. The workaround: push the rebased commit to a NEW branch name and open a fresh PR. Original PR can be closed; the work transfers cleanly.
- Squash-merge endpoint returned 500 for a while tonight; falling back to `merge_method=merge` works. If GitHub backend is healthy again, switch back to squash merges for new PRs.

## Next step

1. **Next.js 14 → 15+ migration** (own dedicated session, since it unlocks the ESLint chain). Vercel currently recommends Next 15+ for new projects.
2. After Next is bumped: eslint 8 → 9/10 + flat-config conversion, @typescript-eslint 7 → 8, eslint-config-next 14 → 16.
3. Manual UI smoke pass after #309 (Tailwind 4) lands in staging — no screenshot regression tests in the repo, so visual parity wasn't formally verified.

## Blocked on user
- Nothing.

## Open questions
- The GitHub PR-head-desync bug consumed real time tonight — if it recurs systematically, consider opening a support ticket. Not actionable code-side.
- Tailwind 4's default-color shifts (border defaults to currentColor, etc.) — the shadcn CSS-var theming insulates us from most of these, but visual parity is not formally verified.

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
