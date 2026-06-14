# Session state — last updated 2026-06-14 19:10 UTC

## Just completed
- **Root-caused + fixed the signup legal-accept 500** ("tenant id doesn't exist" when accepting legal docs). Cause: `legal_documents` (a global catalog with NO `tenant_id` column) was wrongly in `TENANT_SCOPED_TABLES`, so the `tenantClient` proxy injected `.eq("tenant_id", …)` and Postgres hard-errored `column legal_documents.tenant_id does not exist`; the onboarding legal route returned that message verbatim. Confirmed from live prod postgres logs.
- Fix (branch `fix/legal-documents-platform-readable`, uncommitted as of this line): moved `legal_documents` to `PLATFORM_READABLE_TABLES`, added a regression test (`tenantClient.from("legal_documents")` injects no tenant filter), and corrected the false "over-inclusion is fine" comment in `tenant-scoped-tables.ts`. `pnpm verify` green. Same misclassification also affected `onboarding/ica` + public `legal/[doctype]/current` — both fixed by the same one-line reclassification.
- Opened **#1054** — follow-up to audit all of `TENANT_SCOPED_TABLES` for entries lacking a `tenant_id` column (+ optional CI guard).
- MEMORY D-223 added (legal fix). D-222 (#1052 RLS) MEMORY/SESSION housekeeping is bundled into this branch's commit.
- (Prior) #1052 migration merged via PR #1053 (squash `82d9dcbb`).

## In flight
- Branch `fix/legal-documents-platform-readable` — 4 files staged-to-commit: `tenant-scoped-tables.ts`, `tenant-client.test.ts`, `MEMORY.md`, `SESSION.md`. `pnpm verify` passes. Next: commit → push → open PR into dev → run both audit agents (Sonnet; small non-SQL diff) → update Audit block → merge squash → delete branch.

## Next step
- Commit + push `fix/legal-documents-platform-readable`, open PR into dev referencing the legal-accept bug + #1054 follow-up, run d091-reviewer + pre-pr-reviewer, fill the `## Audit` block, merge squash once CI green.

## Blocked on user
- beta053 production deploy approval (user's call in GitHub Actions, run 27508043350).
- Staging verification of the prior signup fix (end-to-end OAuth → tenant creation).
- After this PR merges + deploys: user to re-test the beta signup → legal-accept flow end-to-end.

## Open questions
- **#1052 still OPEN** — gated apply pending: migration to test+prod via #534 → `pnpm rls:snapshot` + commit snapshots → re-run advisor → close.
- #1054 — TENANT_SCOPED_TABLES audit (opened this session).
- Stashed `docs/site-urls.md` domain-change — still stashed, blocked on user.
- #1044 (remainingCount swallow in flush.ts) — non-trivial, tracked as issue.
- #1003 — D-201 vs D-170 role-scope alignment — user hasn't decided.
