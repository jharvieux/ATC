# Session state — last updated 2026-05-26 ~22:00 UTC

## Just completed

This was a long session covering the Apify chain, slop-detection infrastructure, three rounds of Greptile security audits, and Tier-1 bug fixes from the audit findings.

### Apify chain (D-088) — all 5 PRs merged into dev
- #225 Apify-1 — tracked-sailings only (general-pricing Apify path removed; DIY CruiseMapper scraper replaces it)
- #226 Apify-2 — DIY price-range scraper + `general_pricing_ranges` table
- #227 Apify-3 — AI rounding rule (+10% then nearest $100; "around/approximately" framing)
- #229 chore — RAG RLS snapshot regen (had drifted post-migration 0017)
- #230 Apify-4 + Apify-5 — 9 cruise lines enabled with verified `sercul/*` slugs + per-line kill switches + `APIFY_ACTOR_ALLOWLIST` + operator scoped-token runbook

### Vercel preview deploy — first successful build of the project
- Audit doc `docs/runbooks/vercel-env-checklist.md` enumerated 8 empty + 16 missing env vars
- Operator populated values; `vercel deploy` (cloud-build path) succeeded; SSO gate confirmed working
- "site not currently active" was the SSO wall — not a broken deploy

### Slop-detection infrastructure (D-091) — #233 merged
- `atc/no-orphan-todo` (error), `atc/no-narrating-comments` (off, opt-in)
- `pnpm slop-check` diff scanner + GitHub Actions workflow
- CLAUDE.md slop-sweep step added to End-of-session protocol
- 5 pre-existing orphan TODOs cleaned up

### Anti-pattern infrastructure (D-091b) — #239 merged
- `atc/no-unchecked-supabase-mutation` (off — codebase has ~113 instances; flip after cleanup), `atc/no-credentials-in-url` (error), `atc/no-fail-open-on-resource-error` (off)
- 7 CLAUDE.md doctrine bullets
- Punch list doc + anti-patterns catalog

### Three rounds of Greptile audits — 15 PRs total, all closed without merge
- Round 1 (5 PRs, #234–#238): auth+db, crypto+PII, Stripe, Apify, RAG endpoints — ~25 findings, 7 P1
- Round 2 (5 PRs, #240–#244): Inngest crons, tenant routes, forums, host-adapters+email, onboarding+consent — ~18 P1-equivalent findings
- Round 3 (10 PRs, #248–#257): AI wrappers, bookings, quotes, invitations, RAG ingestion, admin reconciliation, CCPA, imports, DNS/white-label, chat — ~18 more findings + 6 new patterns
- **Cross-round totals: 15 audits, ~90 findings, 18 recurring patterns** — all documented in `docs/runbooks/audit-followups-2026-05-26.md`

### Tier-1 fixes from D-091 punch list — 5 merged, 2 in flight
- ✅ #258 — Svix signature verification rewritten to match Svix scheme (msg-id + timestamp + body, base64-encoded, 5-min tolerance, multi-sig). Closes CAN-SPAM exposure from silently-rejected bounce/complaint webhooks. 9 unit tests.
- ✅ #259 — onboarding state-machine: `progressTo` CAS update + `revertTo` enum/direction validation. Closes admin-review-bypass + TOCTOU. 14 tests.
- ✅ #260 — Apify token moved from URL query string to `Authorization: Bearer` header. Closes token-leak via outbound URL logging.
- ✅ #261 — payout CAS lock now verifies row-count via `tryAcquirePayoutLock` helper. Closes payout double-processing on concurrent runs. 4 tests.
- ✅ #264 — `assertValidRevertTarget` uses `Object.hasOwn` (Greptile follow-up on #259 — prototype-chain leak in `target in STAGE_ORDER`). 4 regression tests.
- 🟡 #262 — Stripe webhook: 6 unchecked-mutation sites destructure `{ error }` + dead-code branch removed. Tests expanded to 8 handler branches after Greptile review.
- 🟡 #263 — round-3 findings appended to D-091 punch list. Doc-consistency fixes after Greptile P1 review.

### Procedure change shipped
- **Read every Greptile review before merging.** Greptile posts comments separately (per the operator's setting change). Caught 5 follow-up findings this session that would have otherwise leaked past merge. Specifically: PR #259 had a P1 inline finding (`target in STAGE_ORDER` leaks Object.prototype keys) that I missed when I merged it. Fixed in #264 retroactively.

## In flight

- **#262** (Stripe webhook unchecked mutations) — CI re-running after test expansion to 8 handler branches. Greptile's 4/5 review predated the expansion.
- **#263** (round-3 doc) — CI re-running after Greptile P1 doc-consistency fixes (summary stats clarity + 3 missing P1 items added to quick-wins).

Both ready to merge once CI clears. No code-level blockers.

## Next step

Merge #262 + #263 (notification from current background poll incoming). Then start the next Tier-1 batch — the round-3 audit findings list:

1. **#42 Chat conversation history** (highest product impact — every chat turn is currently stateless; help-AI has the same bug)
2. **#43 Chat kill switch in streaming mode** (check `ai_kill_switch_state.global_paused` BEFORE stream starts, not after)
3. **#44 Haiku PII redact fail-closed** (missing API key currently returns input as `status: 'clean'` — fails OPEN)
4. **#45 CCPA multi-tenant purge fix** (`maybeSingle()` silently skips multi-tenant users — compliance gap)
5. **#46 CCPA export explicit column allowlist** (`select('*')` leaks `tenant_id` + internal columns)
6. **#47 Quote price-lock expiry enforcement**
7. **#48 Quote dispute PDF actually persisted to audit_log**
8. **#49 Quote acceptance CAS guard**
9. **#50–#51 Bookings non-atomic host submit + draft-status CAS**
10. **#52 Admin reconciliation audit-wrapper signature**
11. **#53 Admin reconciliation Haiku prompt-injection mitigation**
12. **#58 OpenAI embedding path enforcement** (bypasses Pattern 8 state machine entirely)

All detail in `docs/runbooks/audit-followups-2026-05-26.md` "Round 3 — recommended Tier-1 additions" section.

## Blocked on user

- Vercel env vars are largely populated. Some optional ones still empty (Resend FROM domain, GitHub App, OAuth Microsoft when enabled) — not blocking dev.
- Production deploy still requires cutting a `release/*` branch (per `.github/workflows/deploy.yml`). Not blocking.

## Open questions

- The 113-site `atc/no-unchecked-supabase-mutation` codebase cleanup is the largest backlog item. Rule is currently `off` because flipping to `error` would block every PR. Worth a dedicated 2-3 day cleanup pass before flipping.
- Help-AI chat at `apps/main/src/app/api/help/sessions/[id]/message/route.ts:195, 267` has the SAME stateless-LLM bug as customer chat. Greptile only flagged the customer chat path; I found this via grep. Should land in the same fix PR.
- The "safe-client wrapper" structural recommendation (Pattern 1 prevention) — wrap Supabase JS calls in a thin `safeUpdate`/`safeInsert` facade that throws on `{error}` truthy. ~1 day to write, then incremental migration. Eliminates Pattern 1 entirely. Not started.
- Two ESLint rules sketched but not implemented: `atc/no-void-async-without-comment` (Pattern 8), `atc/state-machine-input-must-be-literal` (Pattern 11). Both opt-in by design — deferred until operator wants a one-pass audit.
- Error-injection probe (#245 design doc) — real implementation is multi-day project. Recommended sequencing: build shared helpers (`makeFailingDbClient`, `makeMockStripeRequest`, etc.) first, then exercise Tier-1 → Tier-2 → Tier-3 handlers.

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
