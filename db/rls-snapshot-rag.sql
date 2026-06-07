-- AUTO-GENERATED RLS SNAPSHOT - DO NOT EDIT MANUALLY
-- Target: rag
-- Regenerate with: npx tsx scripts/rls-snapshot.ts --target=rag > db/rls-snapshot-rag.sql
-- Generated against schema: public

-- Tables with RLS enabled:
-- public.pending_embedding (rls_enabled)
-- public.rag_ai_call_log (rls_enabled)
-- public.rag_media_assets (rls_enabled)
-- public.rag_retrieval_log_daily (rls_enabled)
--
-- Tables with RLS disabled:
-- public.itineraries (rls_disabled)
-- public.knowledge_chunk_feedback_events (rls_disabled)
-- public.knowledge_chunks (rls_disabled)
-- public.knowledge_ingestion_queue (rls_disabled)
-- public.platform_settings (rls_disabled)
-- public.rag_retrieval_log (rls_disabled)
-- public.schema_migrations (rls_disabled)
-- public.tenant_registry_shadow (rls_disabled)

-- Policies:
-- TABLE: public.rag_media_assets
CREATE POLICY "rag_media_assets_select" ON public.rag_media_assets
  FOR SELECT TO PUBLIC
  USING (scope = 'global'::text OR tenant_id::text = current_setting('request.jwt.claim.tenant_id'::text, true));

-- TABLE: public.rag_retrieval_log_daily
CREATE POLICY "rag_retrieval_log_daily_select" ON public.rag_retrieval_log_daily
  FOR SELECT TO PUBLIC
  USING (true);

