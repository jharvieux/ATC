# Session state — last updated 2026-05-29 07:20 UTC

## Just completed
- **#419 MERGED** — removed the advisory CI `slop-check` GitHub Action (user said "Remove"). PR #419 squash-merged → dev (commit `be6e18e`), branch deleted. Scanner kept local-only (`scripts/slop-check.ts` + `pnpm slop-check` in `pnpm verify` + `pre-pr-reviewer`). Cleaned dead refs (dependabot-retry check list + 3 runbooks). MEMORY.md **D-117** logged. Resolves the slop-check heredoc bug carried from last session.
- **D-106/D-107 RESCUED from stale PR #366** — those two decisions (Anthropic Message Batches pipeline §27.12; pre-cruise scheduler split T-1 direct / T-7-30-90 batched) were drafted 2026-05-28 in PR #366 but never merged, leaving a gap in the live log (D-105 → D-108). Imported verbatim as **D-118** with original numbers + date preserved. (This PR — `docs/import-d106-d107` — in flight.)

## In flight
- **Branch `docs/import-d106-d107`** (off dev @ `be6e18e`): MEMORY.md D-118 prepend (imports D-106 + D-107) + this SESSION.md update. Next: `pnpm verify` → audit subagents → open docs PR with Audit block → merge on green.

## Next step
- Push `docs/import-d106-d107`, open the PR, merge on green. Then recommend the user close stale PR #366 (its unique content is now in D-118).

## Blocked on user
- **Sonnet switch:** session is on Opus 4.7 — run `/model claude-sonnet-4-6` (agent cannot self-invoke). STILL PENDING.
- **Close PR #366?** Its unique content (D-106/D-107) is now imported as D-118. Recommend closing #366 — but closing a PR is a visible action, so awaiting user OK (won't auto-close).
- **Stale spec line (low priority):** `specs/TechSpec/spec-addendum-d091-hardening.md:250` still references the removed slop-check workflow. Specs are read-only — needs explicit user approval to edit.
- **CONFIRM the #384 reinterpretation:** user picked "rewrite as integration tests" for the 4 judgment files. Batch 2 (#417) instead UNIT-tested the 2 with pure-fn seams (bookings allowlist, moderation thresholds) — a DB integration test of pure logic would assert nothing. OK to proceed this way?
- **#384 remaining work is BLOCKED on #386** (integration-test DB harness — does not exist yet): moderation-retry CAS idempotency, `legal/consent.test.ts` publish-plan, `crm/contacts.test.ts` quote-lifecycle + cross-tenant. None have a pure-fn seam.
- **#384 contract tests — FALSIFIED PREMISE** (user picked "build the client wrappers"): Anthropic wrapper already exists (`apps/main/src/lib/ai/call-wrapper.ts`); a new `src/lib/anthropic/chat.ts` would be stub-shaped + violate `atc/no-direct-anthropic-or-openai-import`. No prod code creates a Stripe customer (`checkout.sessions.create` does) → `createCustomer` would be stub-shaped. Point the contract tests at the REAL wrapper / real Stripe call sites instead.
- **#384 E2E** (user picked "build all 28"): 28 Playwright `test.skip` placeholders need a running app + auth fixtures + spec §7.2 product decisions — separate project.
- **#394 / `tenant-on-terminated.ts:51`** (carried): does un-suspend cancel the scheduled `tenant.termination_scheduled` event? If no → real P1.

## Open questions
- **#373** — dependabot dev-deps bump, `regression-suspected`, BEHIND. Left to `dependabot-retry-ci` per CLAUDE.md.
