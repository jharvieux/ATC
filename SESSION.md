# Session state — last updated 2026-06-28 UTC

## Just completed
- Fixed group-create "internal error": `sendGroupInvitationEmail` was documented as fail-silent but had no try/catch; exceptions during email rendering (HMAC key, React render, template resolution) propagated to outer catch → 500. Group rows were already committed so the error was a lie.
- PR #1543 open, branch `fix/group-create-email-throws`
- Issue #1544 opened for prod cleanup of Lisa's duplicate group

## In flight
- PR #1543 needs CI + audit agents before merge (diff is 1 file, 15 lines — Sonnet-tier)

## Next step
- Wait for CI on PR #1543, run d091-reviewer then pre-pr-reviewer, then merge
- After merge: deploy main app so fix is live; then ask Lisa to retry her group creation
- Coordinate prod cleanup of duplicate group per issue #1544

## Blocked on user
- Prod cleanup of Lisa's duplicate group (issue #1544): need to identify which of the two she wants to keep

## Open questions
- What specifically threw inside sendGroupInvitationEmail? Most likely `signUnsubscribeToken` → `hmacKey()` throwing "Missing HMAC key for token purpose 'unsubscribe'" if `INVITATION_TOKEN_HMAC_KEY` is absent in prod. The ref in the server log from respondToAuthError would confirm.
- pre-pr-reviewer computes a different diff hash than CI by default; workaround: explicitly instruct it to use `gh api --paginate --slurp "repos/jharvieux/ATC/pulls/{PR}/files"` with the same jq+sha256 pipeline as the CI gate
