-- §15.14 — Termination schema additions on tenants.
-- terminated_at and terminated_reason already exist from BP01.
-- This migration adds: termination_kind, termination_initiated_by_user_id,
-- suspension_end_at (for the 90-day trailing-payout window per §15.14.1).

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS termination_kind TEXT
    CHECK (termination_kind IS NULL OR termination_kind IN (
      'voluntary','involuntary_content','involuntary_other'
    )),
  ADD COLUMN IF NOT EXISTS termination_initiated_by_user_id UUID
    REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS suspension_end_at TIMESTAMPTZ;

-- Also tracks for CCPA data deletion (§17.10)
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- user_data_export_requests — §17.9 rate limiting (1 per 30d per user)
CREATE TABLE public.user_data_export_requests (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id UUID        NOT NULL REFERENCES auth.users(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  signed_url   TEXT,
  expires_at   TIMESTAMPTZ
);

CREATE INDEX user_data_export_requests_user_idx ON public.user_data_export_requests(auth_user_id, requested_at DESC);

ALTER TABLE public.user_data_export_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_data_export_select ON public.user_data_export_requests FOR SELECT USING (auth_user_id = auth.uid());
CREATE POLICY user_data_export_insert ON public.user_data_export_requests FOR INSERT WITH CHECK (auth_user_id = auth.uid());

GRANT SELECT, INSERT ON public.user_data_export_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.user_data_export_requests TO service_role;
