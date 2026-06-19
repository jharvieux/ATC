# Session state — last updated 2026-06-19 19:05 ET

## Just completed
- Diagnosed live "AI is temporarily unavailable" on the agent support chat (TA-concierge / Captain Dave, lisa-travel tenant).
- Root cause: `ai_call_log.purpose` CHECK constraint drift. The Anthropic call succeeds; the post-call `ai_call_log` insert (call-wrapper.ts → safeAwait, throws per D-094) violated `ai_call_log_purpose_check` because the constraint (last set 2026-06-09, 16 purposes) never grew with the 23-value `AICallPurpose` union. 7 purposes rejected, incl. `ta_chat_main` (the TA-chat purpose). Hit every tenant's TA chat + draft-reply + quote co-pilot + public-token chat + import pipeline; customer `chat_main` was fine.
- Migration `20260706000000_ai_call_log_purpose_sync.sql` widens the constraint to all 23 values. **Applied to prod via psql (user-approved) to unblock**, then PR #1270 merged to dev (squash 8cfa4147; both audits clean on Opus).
- Opened follow-up #1271 (sonnet): static CI guard for AICallPurpose↔constraint drift.
- Logged D-273 in MEMORY.md.

## In flight
- Doc-only PR for D-273 (MEMORY.md) + this SESSION.md, on branch `feature/log-d273-ai-purpose-drift`. About to push + open + merge (audit-exempt doc-only).

## Next step
- Push branch, open doc-only PR into dev, merge once fast checks settle.

## Blocked on user
- Nothing. (Confirm the chat now works on your end — prod constraint verified to include `ta_chat_main`.)

## Open questions
- Prod is behind dev in the migration ledger: `supabase_migrations.schema_migrations` last records `20260704000000`, so `20260704000001`, `20260704000002`, `20260705000000`, and `20260706000000` are pending the next gated prod deploy. The constraint fix is already live (applied out-of-band); the formal migration is idempotent and will record cleanly on next deploy. Worth confirming the next prod deploy runs them in order.
- Separately observed: RAG retrieval was degraded (operator-alerts on /api/chat — graceful, ungrounded answers). Not this incident; flag if it persists.
