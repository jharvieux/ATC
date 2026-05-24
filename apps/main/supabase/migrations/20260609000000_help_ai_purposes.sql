-- BP31 §32.4.4 — Extend ai_call_log.purpose to include the two Help AI values.
--
-- Phase A's lib/help-ai/pii-redaction.ts and Phase B's confidence-scorer
-- stub don't yet emit ai_call_log rows (regex pass is local, scorer is
-- stubbed). Phase C wires the SSE chat handler with `purpose='help_ai_main'`
-- for the main Sonnet call and `purpose='help_ai_supervisor'` for the
-- Haiku preflight, mirroring chat_main / chat_supervisor.

ALTER TABLE public.ai_call_log
  DROP CONSTRAINT IF EXISTS ai_call_log_purpose_check;

ALTER TABLE public.ai_call_log
  ADD CONSTRAINT ai_call_log_purpose_check CHECK (purpose IN (
    'chat_main','chat_supervisor','entity_extraction',
    'memory_extraction','rag_normalization','rag_pii_redaction',
    'rag_relevance_scoring','persona_addendum_screen',
    'forum_moderation','precruise_generation','quote_narrative',
    'embedding','content_normalization','other',
    'help_ai_main','help_ai_supervisor'
  ));
