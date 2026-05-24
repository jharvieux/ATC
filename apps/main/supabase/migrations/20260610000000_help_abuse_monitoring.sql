-- BP32 §32.11 — help_submission_rate abuse dimension + per-customer rate limit.
--
-- Three concerns:
--   1. Extend tenant_usage_metrics with the help_submission_* counter + state.
--      This is the 6th abuse dimension. Per §32.11.2 it has PER-DAY
--      semantics (NOT per-billing-period like the other 5 dimensions);
--      see MEMORY D-068 for the divergence rationale.
--   2. Extend the dimension CHECK constraints on the three tables that
--      reference the dimension enum to allow 'help_submission_rate'.
--   3. New customer_bug_submission_counters table backing the §32.11.4
--      per-customer rate limit (5/day default; counters reset daily).

-- ── (1) tenant_usage_metrics: +3 columns ────────────────────────────────────
ALTER TABLE public.tenant_usage_metrics
  ADD COLUMN help_submission_count          INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN help_submission_limit_state    TEXT        NOT NULL DEFAULT 'ok'
    CHECK (help_submission_limit_state IN ('ok','soft1','soft2','hard')),
  ADD COLUMN help_submission_state_changed_at TIMESTAMPTZ;

-- ── (2) Extend dimension CHECKs to allow 'help_submission_rate' ─────────────
-- tenant_usage_overrides
ALTER TABLE public.tenant_usage_overrides
  DROP CONSTRAINT IF EXISTS tenant_usage_overrides_dimension_check;
ALTER TABLE public.tenant_usage_overrides
  ADD CONSTRAINT tenant_usage_overrides_dimension_check
  CHECK (dimension IN (
    'ai_cost','chat_volume','email_volume','group_invite','rag_cap','help_submission_rate'
  ));

-- abuse_recompute_drift_log
ALTER TABLE public.abuse_recompute_drift_log
  DROP CONSTRAINT IF EXISTS abuse_recompute_drift_log_dimension_check;
ALTER TABLE public.abuse_recompute_drift_log
  ADD CONSTRAINT abuse_recompute_drift_log_dimension_check
  CHECK (dimension IN (
    'ai_cost','chat_volume','email_volume','group_invite','rag_cap','help_submission_rate'
  ));

-- tenant_override_requests
ALTER TABLE public.tenant_override_requests
  DROP CONSTRAINT IF EXISTS tenant_override_requests_dimension_check;
ALTER TABLE public.tenant_override_requests
  ADD CONSTRAINT tenant_override_requests_dimension_check
  CHECK (dimension IN (
    'ai_cost','rag_cap','chat_volume','email_volume','group_invite','help_submission_rate'
  ));

-- ── (3) customer_bug_submission_counters ────────────────────────────────────
-- One row per (user, tenant, day) — UPSERT increments submission_count when
-- a customer successfully submits a bug via §32.10. RLS scoped so tenants
-- see their own; service-role for the per-user UPSERTs (the rate-limit
-- check runs in the bug-submit route handler).
CREATE TABLE public.customer_bug_submission_counters (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES public.users(id),
  tenant_id          UUID NOT NULL REFERENCES public.tenants(id),
  day_anchor         DATE NOT NULL,
  submission_count   INTEGER NOT NULL DEFAULT 0,
  last_submission_at TIMESTAMPTZ,
  UNIQUE (user_id, tenant_id, day_anchor)
);

CREATE INDEX customer_bug_submission_counters_user_day_idx
  ON public.customer_bug_submission_counters (user_id, day_anchor DESC);

ALTER TABLE public.customer_bug_submission_counters ENABLE ROW LEVEL SECURITY;

-- Standard 4-policy RLS — tenant-scoped CRUD via auth_user_in_tenant.
CREATE POLICY customer_bug_submission_counters_tenant_select
  ON public.customer_bug_submission_counters
  FOR SELECT USING (public.auth_user_in_tenant(tenant_id));
CREATE POLICY customer_bug_submission_counters_tenant_insert
  ON public.customer_bug_submission_counters
  FOR INSERT WITH CHECK (public.auth_user_in_tenant(tenant_id));
CREATE POLICY customer_bug_submission_counters_tenant_update
  ON public.customer_bug_submission_counters
  FOR UPDATE USING (public.auth_user_in_tenant(tenant_id))
  WITH CHECK (public.auth_user_in_tenant(tenant_id));
CREATE POLICY customer_bug_submission_counters_tenant_delete
  ON public.customer_bug_submission_counters
  FOR DELETE USING (public.auth_user_in_tenant(tenant_id));
