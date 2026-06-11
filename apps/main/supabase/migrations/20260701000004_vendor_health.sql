-- #786 — Durable vendor health state.
-- Replaces per-instance in-memory registry with a shared Supabase table.
-- The probe upserts results here; the admin page reads via service-role client.

CREATE TABLE IF NOT EXISTS public.vendor_health (
  vendor                TEXT        PRIMARY KEY,
  status                TEXT        NOT NULL DEFAULT 'healthy'
                                    CHECK (status IN ('healthy', 'degraded', 'down')),
  consecutive_failures  INTEGER     NOT NULL DEFAULT 0,
  last_checked_at       TIMESTAMPTZ,
  last_error            TEXT,
  status_changed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.vendor_health ENABLE ROW LEVEL SECURITY;

-- service_role must have explicit grants even though it bypasses RLS.
-- PostgREST issues DML as the service_role role, which needs table-level
-- privileges. Omitting this causes 403 on every probe upsert and admin read.
GRANT SELECT, INSERT, UPDATE ON public.vendor_health TO service_role;

CREATE INDEX IF NOT EXISTS idx_vendor_health_status ON public.vendor_health (status);
