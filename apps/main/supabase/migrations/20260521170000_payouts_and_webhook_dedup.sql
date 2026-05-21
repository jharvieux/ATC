-- §5.3 Payout Balances, Payout Records, Stripe Webhook Events
--
-- Money columns: BIGINT cents per §14.0.1.
-- payout_balances/payout_records: standard four-policy RLS set per §5.1.2.
-- stripe_webhook_events: custom RLS — see db/rls-exceptions.txt for rationale.

CREATE TABLE public.payout_balances (
  tenant_id           UUID        PRIMARY KEY REFERENCES public.tenants(id) ON DELETE RESTRICT,
  pending_cents       BIGINT      NOT NULL DEFAULT 0, -- cents per §14.0.1
  available_cents     BIGINT      NOT NULL DEFAULT 0, -- cents per §14.0.1
  in_transit_cents    BIGINT      NOT NULL DEFAULT 0, -- cents per §14.0.1
  hold_period_days    INTEGER     NOT NULL,
  payout_schedule     TEXT        CHECK (payout_schedule IN ('weekly','biweekly','monthly','on_demand')),
  next_payout_at      TIMESTAMPTZ,
  minimum_payout_cents BIGINT     DEFAULT 5000, -- cents per §14.0.1
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.payout_records (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID        NOT NULL REFERENCES public.tenants(id),
  amount_cents          BIGINT      NOT NULL, -- cents per §14.0.1
  stripe_transfer_id    TEXT        UNIQUE,
  status                TEXT        NOT NULL CHECK (status IN ('processing','paid','failed')),
  statement_period_start DATE,
  statement_period_end  DATE,
  statement_pdf_url     TEXT,
  settled_at            TIMESTAMPTZ,
  failed_at             TIMESTAMPTZ,
  failure_reason        TEXT,
  attempt_generation    INTEGER     NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per H-6 / §7.9a: every Stripe webhook handler MUST insert into this table
-- BEFORE processing the event. ON CONFLICT (stripe_event_id) DO NOTHING ends
-- processing if the event was already handled.
-- tenant_id is nullable: NULL for platform-level events, non-null for Connect.
-- For transfer events, processed_idempotency_key format: 'payout-{payout_records.id}-gen{attempt_generation}' per §14.7.
CREATE TABLE public.stripe_webhook_events (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id           TEXT        NOT NULL UNIQUE,
  event_type                TEXT        NOT NULL,
  endpoint                  TEXT        NOT NULL CHECK (endpoint IN ('platform','connect')),
  tenant_id                 UUID        REFERENCES public.tenants(id),
  raw_event                 JSONB       NOT NULL,
  signature_verified_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_started_at     TIMESTAMPTZ,
  processing_completed_at   TIMESTAMPTZ,
  processing_outcome        TEXT        CHECK (processing_outcome IN ('success','duplicate','error','unhandled')),
  error_detail              TEXT,
  processed_idempotency_key TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX stripe_webhook_events_type_idx ON public.stripe_webhook_events(event_type, created_at DESC);
CREATE INDEX stripe_webhook_events_tenant_idx ON public.stripe_webhook_events(tenant_id, created_at DESC)
  WHERE tenant_id IS NOT NULL;

-- ── RLS: payout_balances ────────────────────────────────────────────────────

ALTER TABLE public.payout_balances ENABLE ROW LEVEL SECURITY;

CREATE POLICY payout_balances_select_policy ON public.payout_balances
  FOR SELECT
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY payout_balances_insert_policy ON public.payout_balances
  FOR INSERT
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY payout_balances_update_policy ON public.payout_balances
  FOR UPDATE
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY payout_balances_delete_policy ON public.payout_balances
  FOR DELETE
  USING (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

-- ── RLS: payout_records ─────────────────────────────────────────────────────

ALTER TABLE public.payout_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY payout_records_select_policy ON public.payout_records
  FOR SELECT
  USING (auth_user_in_tenant(tenant_id));

CREATE POLICY payout_records_insert_policy ON public.payout_records
  FOR INSERT
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY payout_records_update_policy ON public.payout_records
  FOR UPDATE
  USING (auth_user_in_tenant(tenant_id))
  WITH CHECK (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

CREATE POLICY payout_records_delete_policy ON public.payout_records
  FOR DELETE
  USING (
    auth_user_in_tenant(tenant_id)
    AND tenant_is_active(tenant_id)
  );

-- ── RLS: stripe_webhook_events ──────────────────────────────────────────────
-- Custom policy: see db/rls-exceptions.txt for full rationale.
-- User-facing SELECT is restricted to rows where tenant_id IS NOT NULL
-- (platform-level events with tenant_id = NULL are not user-visible).
-- INSERT/UPDATE/DELETE are exclusively via service_role, which bypasses RLS.

ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY stripe_webhook_events_select_policy ON public.stripe_webhook_events
  FOR SELECT
  USING (
    auth_user_in_tenant(tenant_id)
    AND tenant_id IS NOT NULL
  );

-- ── Grants ──────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payout_balances TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payout_balances TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payout_records TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payout_records TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stripe_webhook_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stripe_webhook_events TO service_role;
