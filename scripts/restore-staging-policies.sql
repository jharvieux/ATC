-- =============================================================================
-- restore-staging-policies.sql
-- =============================================================================
-- Run by: .github/workflows/deploy.yml, db-copy job, step
--         "Restore storage RLS policies (#1316)" — AFTER pg_restore + staging
--         fixups, in db-copy, which runs BEFORE deploy-staging's
--         `supabase db push` (db-copy is a `needs:` of deploy-staging). That
--         ordering is safe: these policies' owning migrations (bp34,
--         quote_pdfs, and help_docs) are already recorded in the migration
--         ledger, so the
--         later `db push` treats them as already-applied and is a no-op for
--         them either way — it neither recreates nor disturbs what this file
--         just restored.
-- When:   Every staging refresh, immediately following the public-schema copy.
-- Why:    `DROP SCHEMA public CASCADE` (deploy.yml) drops any object that
--         DEPENDS ON a public object. Storage RLS policies on storage.objects
--         reference public functions (auth_user_in_tenant / tenant_is_active),
--         so CASCADE drops them. The migrations that originally created them
--         (bp34, quote_pdfs, and help_docs) are already in the migration
--         ledger, so the
--         later `supabase db push` treats them as applied and does NOT recreate
--         them — staging is left without storage RLS until this file re-applies
--         it. See issue #1316.
--
-- Role note: the migrations create these exact policies as the `postgres` role
-- during normal `supabase db push`, so re-creating them here as `postgres`
-- works. (Realtime publication membership is a separate case — the
-- supabase_realtime publication is owned by supabase_admin and is restored via
-- capture-and-replay from prod in a dedicated workflow step, not here.)
--
-- Source of truth: the definitions below are copied verbatim from the owning
-- migrations. Keep them in sync if those migrations change:
--   - imported_documents_tenant_select →
--       apps/main/supabase/migrations/20260617000000_bp34_phase_c_gmail_storage.sql
--   - quote_pdfs_tenant_select →
--       apps/main/supabase/migrations/20260625000003_quote_pdfs_bucket.sql
--   - help_docs_tenant_select →
--       apps/main/supabase/migrations/20260814041302_help_docs_storage_tenant_select.sql
--
-- Idempotent (DROP POLICY IF EXISTS before each CREATE) and guarded on the
-- storage schema so a non-Supabase Postgres (local/CI) no-ops cleanly.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'storage') THEN
    RAISE NOTICE 'storage schema absent — skipping storage RLS restore (non-Supabase Postgres).';
    RETURN;
  END IF;

  -- ── imported-documents bucket (BP34) ──────────────────────────────────
  EXECUTE 'DROP POLICY IF EXISTS imported_documents_tenant_select ON storage.objects';
  EXECUTE $sql$
    CREATE POLICY imported_documents_tenant_select
      ON storage.objects FOR SELECT TO authenticated
      USING (
        bucket_id = 'imported-documents'
        AND (storage.foldername(name))[1] = (
          SELECT t.id::TEXT FROM public.tenants t
          WHERE auth_user_in_tenant(t.id) AND tenant_is_active(t.id)
          LIMIT 1
        )
      )
  $sql$;

  -- ── quote-pdfs bucket (§12.4) ─────────────────────────────────────────
  EXECUTE 'DROP POLICY IF EXISTS quote_pdfs_tenant_select ON storage.objects';
  EXECUTE $sql$
    CREATE POLICY quote_pdfs_tenant_select ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'quote-pdfs'
        AND auth_user_in_tenant(
          (regexp_match(name, '^tenant_([0-9a-f-]+)/'))[1]::uuid
        )
      )
  $sql$;

  -- ── help-docs bucket (#2072) ──────────────────────────────────────────
  EXECUTE 'DROP POLICY IF EXISTS help_docs_tenant_select ON storage.objects';
  EXECUTE $sql$
    CREATE POLICY help_docs_tenant_select ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'help-docs'
        AND auth_user_in_tenant(
          (regexp_match(name, '^tenant_([0-9a-f-]+)/'))[1]::uuid
        )
      )
  $sql$;

  RAISE NOTICE 'Storage RLS policies restored: imported_documents_tenant_select, quote_pdfs_tenant_select, help_docs_tenant_select.';
END $$;
