-- #786 — Durable vendor health state.
-- Replaces per-instance in-memory registry with a shared Supabase table.
-- The probe upserts results here; gate.ts reads with short in-process cache.

CREATE TABLE IF NOT EXISTS vendor_health (
  vendor          TEXT        PRIMARY KEY,
  status          TEXT        NOT NULL DEFAULT 'healthy'
                              CHECK (status IN ('healthy', 'degraded', 'down')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMPTZ,
  last_error      TEXT,
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Platform admins may read; service_role owns writes.
ALTER TABLE vendor_health ENABLE ROW LEVEL SECURITY;

CREATE POLICY "platform_admins_read_vendor_health"
  ON vendor_health FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM platform_admins
      WHERE user_id = auth.uid()
    )
  );

-- service_role bypasses RLS — no INSERT/UPDATE policy needed for probe writes.

CREATE INDEX idx_vendor_health_status ON vendor_health (status);
