# Session state — last updated 2026-06-08 (post-#876 merge + both apps redeployed)

## Just completed
- **#868 complete pipeline fixed.** Three layers of bugs, three PRs:
  - #870: RetrieveRequestSchema accepted slugs + null user_id (fixed 400 on every call)
  - #872 + #874: match_knowledge_chunks search_path (pgvector) + PG14 EXTRACT cast + 32s→2s two-phase ANN performance (fixed 500 timeout)
  - #876: ship_lookup + port_lookup structured retrieval paths (fixed wrong chunks for Haven, deck plan, Port Canaveral queries)
- **MEMORY D-186** recorded.
- **Both apps deployed**: atc-rag (new route handlers) + atc-main (entity extraction + retrieve-for-chat changes).

## In flight
- Nothing in flight — clean checkpoint.

## Next step
- **Verify the three originally-failing queries in prod chat:**
  1. "Where is The Haven restaurant on the Norwegian Bliss?" → expect decks 17-19 answer
  2. "Can you send me the deck plan for the Bliss?" → expect cruisemapper.com link
  3. "What ships leave Port Canaveral on 10/23/26?" → expect Disney Wish, Utopia of the Seas, Disney Fantasy
- If any still deflect: check `rag_retrieval_log` for the query — confirm ship_lookup/port_lookup fired (chunks_returned should include the structured chunks)

## Blocked on user
- **Verify the 4 prod env vars** (#862): RESEND_API_KEY, OPENAI_API_KEY, MICROSOFT_GRAPH_CLIENT_ID/_SECRET
- **#857**: opus-4-8 price verify + eval; INNGEST_API_KEY repo secret; ANTHROPIC_API_KEY in CI
- Durable RAG tenant-status sync fix (#875 trigger for feedback_signal_count is also outstanding)

## Open questions
- **Haven**: The deck_intel chunk says "The Haven Lower" on deck 17 and "The Haven Upper" on decks 18-19, but no mention of a specific "restaurant." If the concierge is asked about "The Haven restaurant," the answer will be about the deck location, not a menu or reservation link. This may still feel like a partial deflection if the user wanted booking info.
- The "deck plan" follow-up query ("Can you send a link to the deck plan") requires the ship name in the current message to trigger ship_lookup — a conversational follow-up without re-mentioning the ship won't benefit. This is a known limitation; tracked as a potential follow-up.
- Untracked working-tree security-scan artifacts (THREAT_MODEL.md, VULN-FINDINGS.*, etc.) — surface before any cleanup.
