-- AUTO-GENERATED GRANTS SNAPSHOT - DO NOT EDIT MANUALLY
-- Target: rag
-- Regenerate with: npx tsx scripts/grants-snapshot.ts --target=rag > db/grants-snapshot-rag.sql
-- Generated against schema: public
-- Captures DML grants (SELECT, INSERT, UPDATE, DELETE) for roles anon, authenticated, service_role.

-- TABLE: public.itineraries
GRANT DELETE, INSERT, SELECT, UPDATE ON public.itineraries TO service_role;

-- TABLE: public.knowledge_chunk_feedback_events
GRANT DELETE, INSERT, SELECT, UPDATE ON public.knowledge_chunk_feedback_events TO service_role;

-- TABLE: public.knowledge_chunks
GRANT DELETE, INSERT, SELECT, UPDATE ON public.knowledge_chunks TO service_role;

-- TABLE: public.knowledge_ingestion_queue
GRANT DELETE, INSERT, SELECT, UPDATE ON public.knowledge_ingestion_queue TO service_role;

-- TABLE: public.pending_embedding
GRANT DELETE, INSERT, SELECT, UPDATE ON public.pending_embedding TO service_role;

-- TABLE: public.platform_settings
GRANT DELETE, INSERT, SELECT, UPDATE ON public.platform_settings TO service_role;

-- TABLE: public.rag_ai_call_log
GRANT DELETE, INSERT, SELECT, UPDATE ON public.rag_ai_call_log TO service_role;

-- TABLE: public.rag_media_assets
GRANT DELETE, INSERT, SELECT, UPDATE ON public.rag_media_assets TO service_role;

-- TABLE: public.rag_retrieval_log
GRANT DELETE, INSERT, SELECT, UPDATE ON public.rag_retrieval_log TO service_role;

-- TABLE: public.rag_retrieval_log_daily
GRANT DELETE, INSERT, SELECT, UPDATE ON public.rag_retrieval_log_daily TO service_role;

-- TABLE: public.tenant_registry_shadow
GRANT DELETE, INSERT, SELECT, UPDATE ON public.tenant_registry_shadow TO service_role;

