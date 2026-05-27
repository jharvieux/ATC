# Session state — last updated 2026-05-26 ~22:45 UTC

## Just completed

Continuation of the long D-091 / audit follow-up session. After Tier-1 fixes
(PRs #258–#264), advanced through the "top-10 impact" list to items 1–3:

### Item #1 — Safe-mutation wrapper (PR #265, open)
- `apps/main/src/lib/db/safe-mutation.ts` — `SupabaseMutationError` class +
  `unwrap`, `unwrapRequired`, `safeAwait`, `safeAwaitRowCount` helpers.
- Migrated `apps/main/src/lib/ai/call-wrapper.ts:logAndIncrement` as proof
  of pattern (4 mutation sites).
- `CLAUDE.md` doctrine updated to point at the wrapper.
- 18 unit tests, all passing.

### Item #2 — Chat conversation history (PR #266, open)
- `apps/main/src/lib/chat/conversation-history.ts` — `loadConversationHistory`
  + `trimToBudget` with 50k-char cap, user-first first-message guarantee.
- Customer chat (`apps/main/src/app/api/chat/route.ts`) — loads history once
  after persisting the user message; reused across regen attempts so a
  rewriting iteration doesn't feed its own draft back as context.
- Help-AI chat — when `session.conversation_id` is set, inherits chat-history
  context. Admin-source sessions stay single-turn pending the deeper help-AI
  persistence fix (documented as a known gap).
- 11 unit tests, all passing.

### Item #3 — Error-injection probe foundation (PR #267, open)
- `apps/main/test/error-injection/_helpers.ts` — 4 reusable mocks
  (makeFailingDbClient, makeMockStripeEvent/Request, invokeInngestFunction,
  makeThrowingStripeClass/Fetch).
- `pnpm test:error-injection` script + CI workflow step.
- 11 probe tests passing across 2 handlers:
  - **Stripe webhook** — resource-down + concurrency lanes
    (`apps/main/test/error-injection/stripe-webhook.error.test.ts`).
    DB-fail coverage was already shipped in PR #262
    (`webhook-error-propagation.test.ts`).
  - **GitHub webhook** — full Pattern 1/2/6 coverage
    (`apps/main/test/error-injection/github-webhook.error.test.ts`).
- Coverage table + per-handler remaining-work notes in
  `apps/main/test/error-injection/README.md` and
  `docs/runbooks/audit-followups-2026-05-26.md` "Error-injection probe —
  handler coverage" section.

### Procedure reminder still active
- **Read every Greptile review before merging.** Greptile posts comments
  separately; missing one P1 cost a follow-up PR (#264) earlier this session.

## In flight

- **PR #265** (safe-mutation wrapper) — awaiting CI + Greptile review before merge.
- **PR #266** (chat conversation history) — awaiting CI + Greptile review.
- **PR #267** (error-injection probe foundation) — awaiting CI + Greptile review.

All three are independent — no merge ordering needed.

## Next step

Two equally-valid continuations:

**A. Finish item #3** (the user explicitly chose "Full Tier 1–3 multi-day"
on the scope question). Remaining handlers, in priority order:

1. Extract Inngest cron bodies (`payouts-execute-transfer` non-lock sites,
   `payouts-reconcile-processing`, `abuse-recompute-nightly`,
   `ai-pricing-cache-refresh`) into named exports + add probe tests.
   Recommended as small per-cron PRs following the `tryAcquirePayoutLock`
   precedent.
2. Add `apps/rag/test/error-injection/` for the RAG feedback webhook
   (cross-app, needs its own vitest include + glob entry).
3. Tenant API routes (`tenant/billing`, `tenant/chat-limits`, forums) —
   probe tests + fix the unchecked-mutation Pattern 1 bugs they have
   in the same PR.

**B. Move to round-3 Tier-1 punch list** (the items the user deferred when
they picked "Full Tier 1–3 (multi-day)" for #3):

- #43 Chat kill switch in streaming mode
- #44 Haiku PII redact fail-closed
- #45 CCPA multi-tenant purge fix
- #46 CCPA export explicit column allowlist
- #47 Quote price-lock expiry enforcement
- #48 Quote dispute PDF actually persisted to audit_log
- #49 Quote acceptance CAS guard
- #50–#51 Bookings non-atomic host submit + draft-status CAS
- #52 Admin reconciliation audit-wrapper signature
- #53 Admin reconciliation Haiku prompt-injection mitigation
- #58 OpenAI embedding path enforcement

All detail in `docs/runbooks/audit-followups-2026-05-26.md` "Round 3 —
recommended Tier-1 additions" section.

## Blocked on user

- Vercel env vars largely populated; some optional still empty (Resend FROM
  domain, GitHub App, OAuth Microsoft) — not blocking dev.
- Production deploy still requires cutting a `release/*` branch — not blocking.

## Open questions

- **Help-AI assistant-turn persistence** — help-AI doesn't write its own
  user/assistant rows to `messages`, so within-help-AI multi-turn context
  is still single-turn after PR #266. Full fix is its own PR (decide:
  should help-AI turns count toward chat metrics? what tenant_id scoping
  for admin-source sessions?).
- **113-site `atc/no-unchecked-supabase-mutation` cleanup** — rule still
  `off` because flipping to `error` blocks every PR. After PR #265 lands,
  incremental migration to `safeAwait` is the path; flip the rule after.
- **Two ESLint rules sketched but not implemented:**
  `atc/no-void-async-without-comment` (Pattern 8),
  `atc/state-machine-input-must-be-literal` (Pattern 11). Both opt-in.
- **Error-injection probe — Inngest crons** need the cron-internal refactor
  documented in the probe README; each cron is its own small PR.

## Carried forward (deferred work, unchanged from prior sessions)

- BP39 follow-up: retroactive react-pdf wire-up
- BP31: Haiku tolerable-PII redaction + confidence/clarity scorer (cost-deferred)
- BP30: AI behavior eval harness (cost-deferred)
- BP25: PLATFORM_PEPPER offsite storage + DO-NOT-ROTATE doc
- BP24: populate `platform_settings.supervisor_slur_deny_list`
- BP23: populate `port_info_chunks` content for 17 ports
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer
- §13.9 active vs reactive health probing — operator decision deferred (currently reactive-only per D-087)
- §20.4 / §38.8 / §38.8.1 / §39.5 — customer-facing AI chat panels build (~2 days, needs browser testing)
