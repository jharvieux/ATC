# Session state — last updated 2026-06-08 (post-#878 merge + deploy)

## Just completed
- **#878: Conversation context for entity extraction.** "Can you send me the deck plan?" after discussing Norwegian Bliss now extracts the ship from context and fires ship_lookup. PR #878 merged, atc-main deployed. MEMORY D-187.
- **#876: ship_lookup + port_lookup.** Haven restaurant (decks 17-19), deck plan link, Port Canaveral departures now grounded. Both apps deployed.
- **#874, #872, #870: match_knowledge_chunks perf + DB fixes.** 32s→2s query, search_path/PG14 fixes, contract 400 fix. All live.

## In flight
- **"AI is temporarily unavailable"** error: appeared around 11:39-11:41 UTC (entity extraction + possibly main Anthropic calls failing). Cleared without intervention by ~11:42. Cause unknown — likely transient Anthropic API hiccup or rate limit. No errors in last 30+ min. Monitor.

## Next step
- **Verify follow-up queries in prod**: ask about Norwegian Bliss itinerary, then follow up "Can you send me the deck plan?" → should now return Bliss deck plan link without re-mentioning ship name.
- Watch for recurrence of "AI is temporarily unavailable" error.

## Blocked on user
- **Verify the 4 prod env vars** (#862): RESEND_API_KEY, OPENAI_API_KEY, MICROSOFT_GRAPH_CLIENT_ID/_SECRET
- **#857**: opus-4-8 price verify + eval; INNGEST_API_KEY repo secret; ANTHROPIC_API_KEY in CI
- Durable RAG tenant-status sync (#875 feedback_signal_count trigger)

## Open questions
- "AI is temporarily unavailable" at 11:39-11:41 — entity extraction was hitting `[entity-extraction] failed (degrading to empty entities)`. Entity extraction calls `instrumentedClaudeCall` which calls `loadTenantSnapshot` (DB) then Anthropic. Could be DB hiccup or Anthropic transient. Watch for recurrence.
- Untracked working-tree security-scan artifacts (THREAT_MODEL.md, VULN-FINDINGS.*, etc.) — surface before any cleanup.
