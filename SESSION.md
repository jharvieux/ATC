# Session state — last updated 2026-05-29 07:10 UTC

## Just completed
Overnight autonomous GitHub-issue run — scope "D-091 fixes + #403 + #384" — COMPLETE for all executable items:
- **D-091 fix issues #392–#401** + **#403** termination finalizer → all squash-merged to dev (PRs #404–#413). #380 closed (authorized).
- **#386** operator runbook (nightly test-DB migration off prod-serving atc-main) → PR #414 merged. Operator-blocked; docs-only.
- **#384 batch 1 (clean Class-A extractions)** → PR #415 merged (commit `e98ccad`), branch deleted. Extracted `powered-by` (`resolveShowPoweredBy`) + `reminder-cadence` (`monthsBetween`/`cadenceIntervalDays`) to importable lib modules; tests now import the REAL symbols; deleted a tautology describe block. `pnpm verify` green; both audit subagents run, 2 NITs fixed pre-merge.
- MEMORY.md **D-115** added (the #384 batch-1 decision + what was surfaced vs. executed).

## In flight
- Nothing in flight — clean checkpoint. Local `dev` synced to `origin/dev @ e98ccad`. Working tree clean.

## Next step
- Await user direction on the surfaced #384 judgment items (below) and the Sonnet switch. No autonomous work remains in scope.

## Blocked on user
- **Sonnet switch:** session is on Opus 4.7 — run `/model claude-sonnet-4-6` (agent cannot self-invoke).
- **#384 — delete-vs-rewrite-vs-integration-test judgment** on the 4 remaining Class-A files (no clean pure-fn seam / need write-path refactor): `bookings-patch-state-machine.test.ts`, `forums/moderation-retry-idempotency.test.ts`, `legal/consent.test.ts`, `crm/contacts.test.ts`.
- **#384 — blocked main-body items:** Cross-Tenant Probe (needs §30.4 fixtures + dedicated test DB; couples to #386), Contract Tests (impl files `anthropic/chat.ts` + `stripe/customers.ts` don't exist; STRIPE_TEST_SECRET_KEY pending), E2E (28 empty `test.skip`; needs §7.2/product decisions).
- **#394 / `tenant-on-terminated.ts:51` product question** (carried from D-114): does the un-suspend flow cancel the scheduled `tenant.termination_scheduled` event? If no → real P1.
- All `d091-audit` issues #392–#401, #403, epic #398, #386, #384 remain OPEN by design (PRs used "Implements #N"); user closes after review.

## Open questions
- **Out-of-scope open PRs (NOT touched, surface only):**
  - **#373** — dependabot dev-deps bump, label `regression-suspected`, BEHIND. Per CLAUDE.md leave to `dependabot-retry-ci`; don't touch.
  - **#366** — user's own docs PR (`docs/session-d106-d107`) adding D-106/D-107 to /MEMORY.md, BEHIND. Will CONFLICT with current MEMORY.md (now D-115) on the append-only prepend. Needs the user's attention — I did not touch it.
- **#401 follow-up:** prior-session twin-ternary note at `apify-pricing-adapter.ts:164` — unverified whether it's a genuine stub-shaped remnant.
- d091-reviewer re-surfaced `group-reminder-cadence.ts` unchecked mutations — already tracked under #400 + #393; no new issue filed.

## Carried forward (unchanged)
- BP39 react-pdf wire-up; BP31 Haiku PII scorer (P3 #32); BP30 eval harness (P3 #35); BP25 PLATFORM_PEPPER offsite (P4 #46); BP24 supervisor_slur_deny_list (P4 #45); BP23 port_info_chunks (P4 #44); BP16/17 counsel sign-off (P4 #41); §13.9 health probing (P4 #48); Booking Stages 2/3; persona-addendum-rescreen flush window. Operator follow-ups from D-112 (re-point `supabase-main` MCP off dead ref; prod redeploy).
