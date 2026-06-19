-- Sync ai_call_log.purpose CHECK constraint with the AICallPurpose union.
--
-- Root cause of the "Our AI is temporarily unavailable" incident on the
-- TA / agent support chat: the Anthropic call succeeds, then logAndIncrement
-- (lib/ai/call-wrapper.ts) inserts the ai_call_log row via safeAwait, which
-- throws on any DB error (D-094). The constraint was last set in
-- 20260609000000_help_ai_purposes.sql and never extended as the
-- AICallPurpose union grew, so every call on a newer purpose passed the LLM
-- call but failed the cost-log insert, surfacing to the user as an AI outage.
--
-- 7 purposes the app emits were missing from the constraint:
--   persona_addendum_rescreen, import_classify, import_extract,
--   quote_copilot, public_token_chat, ta_chat_main, draft_reply
-- (ta_chat_main is the agent-support-chat purpose; route.ts:737.)
--
-- This widens the allow-list to the full 23-value union. Purely additive.

ALTER TABLE public.ai_call_log
  DROP CONSTRAINT IF EXISTS ai_call_log_purpose_check;

ALTER TABLE public.ai_call_log
  ADD CONSTRAINT ai_call_log_purpose_check CHECK (purpose IN (
    'chat_main','chat_supervisor','entity_extraction',
    'memory_extraction','rag_normalization','rag_pii_redaction',
    'rag_relevance_scoring','persona_addendum_screen',
    'persona_addendum_rescreen','forum_moderation','precruise_generation',
    'quote_narrative','embedding','content_normalization','other',
    'help_ai_main','help_ai_supervisor',
    'import_classify','import_extract','quote_copilot','public_token_chat',
    'ta_chat_main','draft_reply'
  ));
