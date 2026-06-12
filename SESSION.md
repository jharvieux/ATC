# Session state — last updated 2026-06-11 22:30 CT

## Standing rule (operator, permanent)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous.
**Note (D-205):** there is currently ONE Supabase project (mfaknjyqiwcjojukcnea) serving production — MCP applies ARE prod applies. Gate accordingly until #386/#534 split environments.

## Just completed (this session)
- Ran a Vitals codebase-health scan (overall 6.7/10); full hotspot diagnosis delivered in-session.
- **PR #1014 (merged into dev):** extracted the 435-line service-role allowlist out of the ESLint rule into `packages/config/eslint-rules/service-role-allowlist.js`. Entries byte-identical (set-diff verified), no behavior change. Both audit agents clean. Logged as D-211.
- Filed deferred chat-route refactors as issues **#1015** (`resolveChatQuota`, do first) and **#1016** (`runGenerationLoop`); both `enhancement` + `refactor`. Created the `refactor` label. Logged as D-212.

## In flight (this session)
- Branch `docs/service-role-allowlist-process` (off dev). Uncommitted: CLAUDE.md (additive-list line now lists `service-role-allowlist.js`), MEMORY.md (D-211 + D-212), SESSION.md (this file), .gitignore (`.vitals/` ignore). NOT doc-only-exempt (.gitignore breaks it) → audit agents required. Next: verify → commit → PR → audit agents (Sonnet) → merge.

## Carried over from prior session — NOT touched this session (status unverified)
- PRs **#993, #994, #1007**: per the last checkpoint, all CI green except `pr-audit-section-check` (marker-comment diff-hash mismatch, D-204); needed update-branch (serially, #993/#994 touch db snapshots) + audit re-run + merge. Verify current state before acting.
- PR **#1009** (tenant branding §16.2, D-209): last checkpoint had it update-branched with audit findings in body but markers unposted from the prior container. Verify whether it merged.
- Branch `feature/712-personal-api-tokens` (PR #995, already merged) flagged for deletion.

## Next step
- Finish the in-flight docs PR (above). Then, if resuming the carry-over queue, re-verify each PR's actual current status (don't trust this stale snapshot) before update-branching/re-auditing.

## Blocked on user
- Nothing for this session's work.

## Open questions (carried over)
- #1003: D-201 narrowing — reviewer scope/mechanism (user chose to defer)
- #1008: theming sweep for remaining customer surfaces (deferred from PR #1009)
