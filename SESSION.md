# Session state — last updated 2026-06-20 21:50 UTC

## Just completed
- Merged PR #1301: create-github-app-token @v1→@v3 (PKCS#8 key support)
- Merged PR #1300: familiarity level buttons — tone constants, TaPrefsPanel loads saved tone
- Merged PR #1302: header dedup + portal theme toggle + user avatar in hamburger
- Merged PR #1305: follow-ups #1303/#1304 — InlineDraftView prefills saved tone from /api/memory; #ta-theme-slot migrated from getElementById to ThemeSlotContext (new theme-slot-context.tsx); removed vestigial SiteHeader span
- Merged PR #1306: release.yml switched from GitHub App token to fine-grained PAT (GH_PAT) — fixes the contents:write 403 on the release-branch push. **User confirmed the release workflow works now.**
- Merged PR #1308: dependabot-update-branch.yml switched to GH_PAT too (same root cause)
- Logged D-279 (PAT decision) to MEMORY

## In flight
- Nothing in flight — clean checkpoint

## Next step
- Session clean. Next task is whatever the user brings.

## Blocked on user
- Nothing

## Open questions
- Issue #1309 (open): add test coverage for tone-level <-> label mapping in InlineDraftView + TaPrefsPanel; ideally extract toneLevelToLabel/toneLabelToLevel into lib/tone/constants.ts. Flagged as a non-blocking NIT on #1305.

## Notes
- GH_PAT (fine-grained, repo jharvieux/ATC) needs: Contents R/W, Pull requests R/W, Metadata R (auto). No "Checks" permission exists for fine-grained PATs. User created the secret; release pipeline confirmed working.
- Issues closed this session: #1303, #1304 (by #1305), #1307 (by #1308).
- Model: user switched to Opus 4.8 mid-session and saved it as their new default — left as-is (deliberate user choice, not auto-reverted to Sonnet).
