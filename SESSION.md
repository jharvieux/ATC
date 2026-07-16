# Session state — last updated 2026-07-16 08:45 CDT (sweep-hygiene process fixes)

## Just completed

**D-357 sweep-hygiene overhaul merged** (PR #1962) — operator-directed fixes for the three failure modes from the D-356 retrospective:

1. **Stale/dup issue work** — executors now verify a defect still exists (code read / failing test / `git log` on touched paths) before implementing; already-fixed issues are closed with evidence under a new `closed_stale` summary field. Wrap-up issue-filing gains a mandatory dup-check (open AND closed issues, plus deduping the sweep's own follow-up list) — comment/reopen instead of filing twins.
2. **Negation-blind closing keywords** — "does not close #N" still closes #N, and strays hide in commit messages via the COMMIT_MESSAGES squash autofill. New rules in both `/issue-sweep` copies AND `docs/runbooks/pr-workflow.md` (general-PR scope): keywords only as intentional standalone `Closes #n` PR-body lines; keyword-free refs everywhere else; pre-merge `gh pr view --json closingIssuesReferences` check; explicit `--subject`/`--body` on squash merges; immediately reopen wrong closes.
3. **Net issue growth** — fix-inline-by-default criteria for en-route findings and audit findings (same subsystem, no supervised path/migration/new route, same verify run, doesn't ~double the diff); `follow_ups` must name a concrete blocker; wrap-up gains a drop-with-rationale disposition for nits and a net closed/filed ledger. Triage JSON gains `blockers[]`; the plan gate presents each blocker as a concrete yes/no ask so the operator grants permissions upfront (supervised-file edits, secrets, prod actions, spec rulings) instead of batches parking mid-sweep.

User-level portable copy (`~/.claude/commands/issue-sweep.md`) updated in lockstep. MEMORY D-357 logged.

Also observed: PR #1959 (RAG test-DB reset) merged before this session's PR; sweep ledger was already deleted.

## In flight

Nothing in flight — clean checkpoint.

## Next step

Next `/issue-sweep` runs under the new rules — watch the wrap-up net ledger to confirm the filed-vs-closed trend inverts. Carried-over operator items below are unchanged.

## Blocked on user

- **#1523** — enable leaked-password protection (Supabase dashboard).
- **#1740** — 2 of 3 errors need prod DDL (`review_submitted_at` ledger/DDL divergence can't self-heal; `attribution_rollup` MV refresh).
- **#1926** — `prod-drift-check` + `contracts-canary` failing daily.
- **#1950** — is `reconcile-statement-automated.ts` in scope for perf work?
- **Prod is ~170+ commits behind dev**; release cut is a scheduling call (blocks #1843 strict flip).
- Carried over: #1911, #1868–#1870, #444 sub-issues (#1257/#1260 operator, #1258/#1259 attorney via #427, #1262 launch gate).

## Open questions

- `deploy.yml:415` skips the RLS drift step on `dev` pushes — dev can't catch out-of-band drift until it blocks every PR at once. Worth a decision.
- #1912 reopened — durable fix is gating the reset effect on an actual type change (PR #1943 only narrowed the flake window).
