-- #875: keep knowledge_chunks.feedback_signal_count in sync with
-- knowledge_chunk_feedback_events so the feedback-weighting gate in
-- match_knowledge_chunks fires correctly once real events exist.
--
-- Uses COUNT(*) (re-count on every event) rather than INCREMENT/DECREMENT to
-- be safe on concurrent inserts and on the DELETE path (no off-by-one risk).
--
-- SECURITY DEFINER with fixed search_path follows the pattern established in
-- 0022_revoke_public_execute_security_definer_rpcs.sql for RAG trigger functions.

CREATE OR REPLACE FUNCTION public.sync_feedback_signal_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_chunk_id UUID;
BEGIN
  target_chunk_id := COALESCE(NEW.chunk_id, OLD.chunk_id);
  UPDATE knowledge_chunks
  SET feedback_signal_count = (
    SELECT COUNT(*) FROM knowledge_chunk_feedback_events WHERE chunk_id = target_chunk_id
  )
  WHERE id = target_chunk_id;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sync_feedback_signal_count() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_feedback_signal_count() TO service_role;

CREATE TRIGGER trg_sync_feedback_signal_count
AFTER INSERT OR DELETE ON public.knowledge_chunk_feedback_events
FOR EACH ROW EXECUTE FUNCTION public.sync_feedback_signal_count();
