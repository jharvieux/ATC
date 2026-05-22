-- §10.1a Per-Conversation Regen Budget
--
-- Tracks cumulative regen activity per conversation. Both thresholds
-- are checked independently — either one trips exhaustion.
-- regen_budget_exhausted_at persists until manually reset by an agent
-- or the conversation is closed and a new one starts.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS regen_tokens_consumed       INTEGER   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS regen_count_total           INTEGER   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS regen_budget_exhausted_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS supervisor_slur_consecutive_count INTEGER NOT NULL DEFAULT 0;
