# Session state — last updated 2026-07-07 05:50 UTC

## Just completed
- Fixed issue #1638 (money-formatter consolidation), which had been cancelled after audit found its single commit didn't actually contain the claimed call-site migrations. Cut a fresh branch off `dev`, redid the consolidation for real:
  - 14 files migrated off local `dollars()`/`formatPrice()`/`formatMoneyCents()`/inline `cents/100` patterns onto the canonical `formatCents(cents, currency?)` in `lib/money.ts`.
  - Fixed the admin/pricing `<input type="number">` bug the audit had found: those specific call sites use `fromCents()` (plain decimal), not `formatCents()` (currency string, which blanks number inputs).
  - PR #1638 closed as superseded; new PR **#1657 merged** into `dev` (627b7c25).
- Went through 3 rounds of the parallel d091-reviewer/pre-pr-reviewer audit loop before merge — all real findings, all fixed:
  - Round 1: `fromCents` had been widened to accept plain `number` (brand-type erosion), `formatCents` had no test coverage, a 13th divergent formatter (`formatDollars` in admin/resources) was walked past.
  - Round 2 fix (casting `cents as any as Cents`) was itself flagged — an `any`-escape is worse than the widening it replaced.
  - Round 3: fixed properly with `BigInt(Math.round(cents)) as Cents` (real runtime conversion, no `any`). Both agents came back clean (0 blockers/warnings).
- Filed **#1658**: `formatCents` always divides by 100 regardless of currency, so zero-decimal currencies (JPY, KRW) render 100x too small. Pre-existing bug inherited from all 12 original formatters, not introduced by #1657 — deferred rather than fixed in-PR since a real fix needs a product decision on how non-2-decimal-currency cents are stored. A regression test documents the current (buggy) behavior.
- D-319 logged in MEMORY.md with full detail on the 3-round audit loop and what was rejected at each round.

## In flight
- Nothing in flight on `apps/**` — the only open item is this SESSION.md + MEMORY.md update itself, on branch `docs/d319-money-consolidation-memory` (off `dev`), not yet pushed/PR'd.

## Next step
- Push `docs/d319-money-consolidation-memory`, open a doc-only PR into `dev` (exempt from audit agents per the doc-only exemption), and merge once CI is green.
- Run `/issue-sweep` when the operator invokes it (unchanged; D-315: backlog #1575–#1613 goes THROUGH the sweep, not ahead of it).

## Blocked on user
- Operator invoking `/issue-sweep` (their chosen route for the #1575–#1613 backlog, per D-315).
- `feature/sweep-money-1606` branch still exists, holding unrelated doc changes from the original cancelled batch (CLAUDE.md anti-patterns 21–26, `.claude/agents/d091-reviewer.md`, `docs/runbooks/anti-patterns.md` additions) that were NOT carried into #1657. Left in place per "never delete branches without permission" — operator should decide whether to salvage that doc work into its own PR or let the branch go stale.

## Open questions
- #1658 (JPY/zero-decimal-currency formatCents bug) needs a product decision before it can be fixed: does the platform store non-2-decimal-currency amounts as true minor-unit cents, or would a currency-aware divisor be introduced? Not urgent unless a non-USD/EUR/GBP tenant is onboarded.
- Carried: RAG ship-stats backfill script (PR #1566) never dry-run against any DB; `signature_feature` curation path (#1565) deferred.
- Carried: Resend's exact pre-bounce retry window is unpublished — if the number ever matters, ask Resend support (noted in #1611).
- Untracked in repo (pre-existing, untouched): `specs/GroupLandingPage.zip`, `specs/design_handoff_group_landing/`.
