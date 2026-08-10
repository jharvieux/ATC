# Session state — last updated 2026-08-10 16:54 CDT

## Just completed
- Discarded the redundant local `AGENTS.md` RTK addition; `AGENTS.md` is clean against `dev`.
- Removed the obsolete untracked Memtrace `.codex/config.toml`; no Memtrace configuration or license material is in the branch.
- Kept the useful shared Codex hook configuration and pre-PR reviewer definition in PR #2085.
- Repaired the audit findings so Codex `apply_patch` input is enforced by the canonical spec/MEMORY guard and all changed application TypeScript files are linted.
- Closed macOS case-alias and blank-context MEMORY guard bypasses found by the D-091 audit.
- Added Codex wire-format, case-alias, and fail-loud regression coverage; 23 focused tests pass.
- Full `pnpm verify` passes on the corrected hook implementation.

## In flight
- PR #2085 on `feature/codex-project-config`; implementation is complete with final audits and CI pending on the current head.

## Next step
- Run full `pnpm verify`, commit and push the audit fixes, rerun both required PR audits, then merge after every required check is green.

## Blocked on user
- Nothing

## Open questions
- #2044 still requires a Supabase PAT with `database:read` + `advisors_read` in `SUPABASE_ACCESS_TOKEN` before rerunning `supabase-advisor-check`.
- #2079 still requires Stripe Connect on the test platform before rerunning `contracts-canary`.
- #2080 tracks the residual moderate `@opentelemetry/core` advisory with no compatible patched 1.x line.
