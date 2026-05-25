-- §12.4 — Storage bucket for sent-quote PDFs.
--
-- Mirrors the BP39 trip-itinerary-pdfs bucket: private, application/pdf
-- only, 20 MB cap. Created via the same pg_namespace guard so CI test
-- DBs (which lack the storage schema) skip cleanly.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'storage') THEN
    EXECUTE $sql$
      INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      VALUES (
        'quote-pdfs',
        'quote-pdfs',
        FALSE,
        20 * 1024 * 1024,
        ARRAY['application/pdf']::TEXT[]
      )
      ON CONFLICT (id) DO NOTHING
    $sql$;

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
  END IF;
END;
$$;
