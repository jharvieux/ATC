-- #875: keep knowledge_chunks.feedback_signal_count in sync with
-- knowledge_chunk_feedback_events so the feedback-weighting gate in
-- match_knowledge_chunks fires correctly once real events exist.
--
-- Uses COUNT(*) (re-count on every insert) rather than INCREMENT to be safe
-- under concurrent inserts (no lost-update risk on the counter).
--
-- Scoped to AFTER INSERT only. The only DELETE path on this table is the
-- ON DELETE CASCADE from knowledge_chunks (see 0005_feedback_factor.sql).
-- That cascade fires while the parent chunk is mid-deletion — running a
-- recount UPDATE against a doomed, already-locked row is wasted work.
-- feedback/route.ts is insert-only (no direct event deletes exist).
--
-- SECURITY DEFINER + schema-qualified tables + fixed search_path follows the
-- pattern in 0022_revoke_public_execute_security_definer_rpcs.sql.

CREATE OR REPLACE FUNCTION public.sync_feedback_signal_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.knowledge_chunks
  SET feedback_signal_count = (
    SELECT COUNT(*) FROM public.knowledge_chunk_feedback_events WHERE chunk_id = NEW.chunk_id
  )
  WHERE id = NEW.chunk_id;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sync_feedback_signal_count() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_feedback_signal_count() TO service_role;

CREATE TRIGGER trg_sync_feedback_signal_count
AFTER INSERT ON public.knowledge_chunk_feedback_events
FOR EACH ROW EXECUTE FUNCTION public.sync_feedback_signal_count();
