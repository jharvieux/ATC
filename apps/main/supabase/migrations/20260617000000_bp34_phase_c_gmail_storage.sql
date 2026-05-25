-- BP34 Phase C — Gmail inbound + storage bucket for document uploads.
--
-- §34.2 Gmail integration storage:
--   * gmail_oauth_tokens: per-tenant encrypted Gmail OAuth refresh token,
--     plus health columns surfaced to the CRM (§34.2.4 health requirement).
--   * gmail_inbound_messages: raw inbound messages received via Pub/Sub
--     before the trigger-detector picks IMPORT messages out for the
--     import pipeline. Non-trigger messages flow into normal Gmail
--     conversation handling (§23.1) — that integration table reads from
--     the same row but with different downstream consumers.
--
-- §34.3 + §34.4 storage bucket:
--   * imported-documents: private bucket for uploaded source documents
--     (PDFs, images). Files are written by the upload route with key
--     pattern `<tenant_id>/<import_queue_id>.<ext>` and removed by the
--     purge-parsed-documents cron after the 24h post-acceptance window.

-- ── Gmail OAuth tokens ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.gmail_oauth_tokens (
  tenant_id              UUID         PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,

  -- Encrypted token blob (BP14 APP_ENCRYPTION_KEY_* framework). The
  -- ciphertext is opaque to RLS — only service-role decryptors should
  -- read this column. We still RLS-protect the row so tenants can't see
  -- each other's existence. Stored as base64 TEXT (matches the
  -- credential-cipher API contract: { ciphertext: string, key_id: string }).
  encrypted_refresh_token TEXT,
  encryption_key_version  TEXT,

  -- Health surfacing (§34.2.4).
  health_status          TEXT         NOT NULL DEFAULT 'disconnected'
    CHECK (health_status IN ('connected','token_expired','revoked','disconnected')),
  last_healthy_at        TIMESTAMPTZ,
  last_health_check_at   TIMESTAMPTZ,
  last_health_error      TEXT,

  -- Pub/Sub watch state (Gmail's `users.watch` API). The watch must be
  -- renewed every 7 days; cron handles that, this column tracks expiry.
  pubsub_watch_expires_at TIMESTAMPTZ,
  pubsub_history_id       TEXT,

  connected_email        TEXT,
  connected_at           TIMESTAMPTZ,

  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE public.gmail_oauth_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY gmail_oauth_tokens_select ON public.gmail_oauth_tokens
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
-- INSERT/UPDATE/DELETE only via service role (token writes happen on the
-- OAuth callback path which runs server-side).
GRANT SELECT ON public.gmail_oauth_tokens TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gmail_oauth_tokens TO service_role;

-- ── Gmail inbound messages ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.gmail_inbound_messages (
  message_id          TEXT         PRIMARY KEY,  -- Gmail's message-id (globally unique)
  tenant_id           UUID         NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

  thread_id           TEXT,
  from_email          TEXT,
  to_email            TEXT,
  subject             TEXT,
  body_text           TEXT,
  body_html           TEXT,
  received_at         TIMESTAMPTZ  NOT NULL,
  raw_payload         JSONB,                     -- Gmail message resource

  -- §34.2 import trigger detection result.
  qualifies_for_import BOOLEAN     NOT NULL DEFAULT FALSE,
  triggered_at        TIMESTAMPTZ,               -- when import.queued was emitted

  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gmail_inbound_tenant_received_idx
  ON public.gmail_inbound_messages (tenant_id, received_at DESC);

ALTER TABLE public.gmail_inbound_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY gmail_inbound_select ON public.gmail_inbound_messages
  FOR SELECT TO authenticated
  USING (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
GRANT SELECT ON public.gmail_inbound_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gmail_inbound_messages TO service_role;

-- ── Storage bucket for document uploads ───────────────────────────────
-- The bucket is private; access is mediated entirely via the application
-- (signed URLs from the review queue UI when an agent inspects a pending
-- item). The upload route writes via service-role.
--
-- Wrapped in a DO block + IF EXISTS guard so CI/local Postgres without the
-- Supabase `storage` extension skip cleanly. Production Supabase always has it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'storage') THEN
    EXECUTE $sql$
      INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      VALUES (
        'imported-documents',
        'imported-documents',
        FALSE,
        10 * 1024 * 1024,
        ARRAY['application/pdf']::TEXT[]
      )
      ON CONFLICT (id) DO NOTHING
    $sql$;
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
  END IF;
END;
$$;
