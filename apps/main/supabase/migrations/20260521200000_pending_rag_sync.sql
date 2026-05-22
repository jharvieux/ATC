-- §8.7a: pending_rag_sync — retry queue for failed RAG tenant-event deliveries
--
-- When publishTenantEvent fails all 3 retries, the event is stored here.
-- The rag-sync-retry Inngest cron re-attempts delivery on the backoff schedule.
--
-- RLS: platform-internal table; no authenticated-user access. Service-role only.
-- Documented in db/rls-exceptions.txt.

CREATE TABLE public.pending_rag_sync (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  event_type       TEXT        NOT NULL CHECK (event_type IN (
                                 'tenant.created',
                                 'tenant.status_changed',
                                 'tenant.terminated',
                                 'tenant.metadata_updated'
                               )),
  payload          JSONB       NOT NULL,
  source_revision  INTEGER     NOT NULL,
  attempt_count    INTEGER     NOT NULL DEFAULT 0,
  next_retry_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at  TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at     TIMESTAMPTZ
);

-- Partial index: only undelivered rows are relevant for the retry cron
CREATE INDEX pending_rag_sync_ready_idx
  ON public.pending_rag_sync (next_retry_at ASC)
  WHERE delivered_at IS NULL;

-- ── RLS ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.pending_rag_sync ENABLE ROW LEVEL SECURITY;

-- No user-facing policies. All access is via service_role (bypasses RLS).
-- This is a platform-internal table with no user-visible data.

-- ── Grants ───────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pending_rag_sync TO service_role;
