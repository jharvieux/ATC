-- Migration: help_docs_storage_tenant_select
-- Version:   20260814041302
-- Generated: 2026-08-14T04:13:02Z by scripts/new-migration.sh
-- Branch:    feature/sweep-storage-2072
-- Worktree:  atc-sweep-storage-2072
--
-- Register the private help-docs export bucket in migration-built environments
-- and allow authenticated users to read only objects beneath their tenant key.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'storage') THEN
    EXECUTE $sql$
      INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      VALUES (
        'help-docs',
        'help-docs',
        FALSE,
        50 * 1024 * 1024,
        ARRAY[
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ]::TEXT[]
      )
      ON CONFLICT (id) DO NOTHING
    $sql$;

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
  END IF;
END;
$$;
