# Session state — last updated 2026-06-19 TZ

## Just completed
- Context-trimming pass to cut session-start token load (~125K → ~12.5K tokens, ~90%):
  - Created `MEMORY-INDEX.md` — one line per decision (254 entries, ~6K tokens) as the session-start read; `MEMORY.md` stays the append-only archive, grepped on demand. File header carries a rebuild snippet.
  - Condensed the verbose D-091 block in `CLAUDE.md` into a 14-item authoring checklist pointing to `docs/runbooks/anti-patterns.md`.
  - Ported the 2 patterns that were only in CLAUDE.md into the runbook (§13 expand-migrate-contract #137, §14 permission-grants-with-route #1173) so nothing was lost.
  - Updated `CLAUDE.md` session-start protocol (read INDEX, not full MEMORY) + index-sync note in the MEMORY section + branch-protection callout near the top.

## In flight
- PR for branch `docs/trim-session-context` (off dev). Doc-only (all `.md`) → audit agents not required, heavy CI skips. Opening now.

## Next step
- Push `docs/trim-session-context`, open PR into dev, merge once the fast checks settle.
- User adds `TEST_E2E_OWNER_EMAIL` and `TEST_E2E_OWNER_PASSWORD` to GitHub repo secrets (Settings → Secrets → Actions) — see issue #1286; then verify `Playwright (Tier 1 + 2 + 2.5)` passes on next CI run.
- Next implementable engineering issue after #709 partial — check issue list for unblocked items.

## Blocked on user
- `TEST_E2E_OWNER_EMAIL` and `TEST_E2E_OWNER_PASSWORD` need to be added to GitHub repo secrets (issue #1286)
- Issue #1259: attorney sign-off on §15.14.6 wording required before implementation
- Issue #1159: needs beta deployment URL + Stripe test credentials in CI + OAuth sign-up scripting (infrastructure gap)
- Issue #1162: blocked on sub-issues #1257, #1258, #1259, #1260 — all still open

## Open questions
- MEMORY-INDEX.md sync is now a manual step when adding a MEMORY entry (documented in the index header + CLAUDE.md). If it drifts, rerun the rebuild snippet. Could be automated with a git hook later if the manual step proves error-prone — not built here (would break this PR's doc-only nature).
- #709 remaining 23 fixmes: email-connection (#429 Gmail OAuth not provisioned), customer-portal (routes not built), booking (#424 handlers still 501), onboarding (#441 complex flow), agent-chat (needs live endpoint), agent-discovery (needs live agent slugs), auth (OAuth-only sign-in, no form), help (needs help module UI wiring)
- After all blocked issues, what's next in the backlog? May need user to re-prioritize.
