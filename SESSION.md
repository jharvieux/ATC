# Session state — last updated 2026-06-11 13:56 UTC

## Standing rule (operator, permanent)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous.
**Note (D-205):** there is currently ONE Supabase project (mfaknjyqiwcjojukcnea) serving production — MCP applies ARE prod applies. Gate accordingly until #386/#534 split environments.

## Just completed
- Tenant branding applied at runtime (§16.2), D-209 — **PR #1009 opened into dev** from `claude/tenant-branding-ui-1piloz`
- Both audit agents ran (Opus first run, 18-file diff): d091 PASS (2 nits), pre-pr clean (2 informational nits); nit fixes pushed; PR `## Audit` section filled with combined report + Status line
- Opened issue #1008 (remaining unbranded customer surfaces, deferred)

## In flight
- **PR #1009 cannot turn fully green from this remote session**: the container has no `gh` CLI and the network policy blocks the GitHub API, so the audit agents could not self-post their hash-bound marker comments (`<!-- d091-audit:v1 diff:... -->` / `<!-- prepr-audit:v1 ... -->`). The `pr-audit-section-check` will fail until both agents are RE-RUN from a gh-capable (local) session — Sonnet re-run is fine per CLAUDE.md; they recompute the hash from the PR files API and self-post. Do NOT post markers manually.

## Next step
- From a gh-capable session: re-run d091-reviewer + pre-pr-reviewer against PR #1009 so they post marker comments; then wait for CI and squash-merge (delete branch). Findings are expected to match the report already in the PR body.

## Blocked on user
- Nothing (PR merge is blocked on the marker-comment re-run above, not on a decision).

## Open questions
- #1003: D-201 narrowing — reviewer scope and mechanism review (user chose to defer)
- PRs #993/#994/#995 still open; user said "merge everything later"
- #1008: theming sweep for remaining customer surfaces (deferred from PR #1009)
