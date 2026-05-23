-- §27.7 / §27.9 / §27.11 — BP28 schema additions.
--
-- Three concerns:
--   1. abuse_recompute_drift_log — visibility into when the nightly
--      recompute corrects real-time UPSERT drift.
--   2. tenant_usage_overrides.expiry_notified_at — track whether the
--      expiry-sweep cron has already notified for a given override
--      (§27.14 "expiry should fire a notification").
--   3. tenant_override_requests — tenant-initiated override-capacity
--      requests; admin approves to create a tenant_usage_overrides row.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. abuse_recompute_drift_log
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.abuse_recompute_drift_log (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES public.tenants(id),
  dimension           TEXT        NOT NULL CHECK (dimension IN (
                        'ai_cost','chat_volume','email_volume','group_invite','rag_cap'
                      )),
  real_time_value     BIGINT      NOT NULL,
  recomputed_value    BIGINT      NOT NULL,
  drift_amount        BIGINT      NOT NULL,
  billing_period      DATERANGE,
  detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX abuse_recompute_drift_log_tenant_idx
  ON public.abuse_recompute_drift_log(tenant_id, detected_at DESC);

ALTER TABLE public.abuse_recompute_drift_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY ardl_select_service ON public.abuse_recompute_drift_log
  FOR SELECT USING (FALSE);
CREATE POLICY ardl_insert_service ON public.abuse_recompute_drift_log
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY ardl_update_service ON public.abuse_recompute_drift_log
  FOR UPDATE USING (FALSE);
CREATE POLICY ardl_delete_service ON public.abuse_recompute_drift_log
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.abuse_recompute_drift_log TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. tenant_usage_overrides — expiry_notified_at column
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.tenant_usage_overrides
  ADD COLUMN IF NOT EXISTS expiry_notified_at TIMESTAMPTZ;

COMMENT ON COLUMN public.tenant_usage_overrides.expiry_notified_at IS
  '§27.14 / BP28: timestamp the expiry-sweep cron notified admin that this override expired. NULL until notified.';

-- ──────────────────────────────────────────────────────────────────────────
-- 3. tenant_override_requests — tenant-initiated request surface
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.tenant_override_requests (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID        NOT NULL REFERENCES public.tenants(id),
  dimension                   TEXT        NOT NULL CHECK (dimension IN (
                                'ai_cost','rag_cap','chat_volume','email_volume','group_invite'
                              )),
  requested_threshold_kind    TEXT        CHECK (requested_threshold_kind IN (
                                'soft1','soft2','hard','base_cap'
                              )),
  current_state               TEXT        NOT NULL,
  reason                      TEXT        NOT NULL,
  requested_by_user_id        UUID        REFERENCES public.users(id),
  requested_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status                      TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','approved','denied')),
  reviewed_by_user_id         UUID        REFERENCES public.users(id),
  reviewed_at                 TIMESTAMPTZ,
  -- Set to the created tenant_usage_overrides.id on approval.
  resulting_override_id       UUID,
  deny_reason                 TEXT
);

CREATE INDEX tenant_override_requests_pending_idx
  ON public.tenant_override_requests(requested_at DESC)
  WHERE status = 'pending';

CREATE INDEX tenant_override_requests_tenant_idx
  ON public.tenant_override_requests(tenant_id, requested_at DESC);

ALTER TABLE public.tenant_override_requests ENABLE ROW LEVEL SECURITY;

-- Tenants can read their own requests + create new ones; admin handles status changes.
CREATE POLICY tor_select_in_tenant ON public.tenant_override_requests
  FOR SELECT USING (auth_user_in_tenant(tenant_id));
CREATE POLICY tor_insert_in_tenant ON public.tenant_override_requests
  FOR INSERT WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY tor_update_service ON public.tenant_override_requests
  FOR UPDATE USING (FALSE);
CREATE POLICY tor_delete_service ON public.tenant_override_requests
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT ON public.tenant_override_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_override_requests TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. abuse_notification_copy seed — operator-editable email copy per
--    dimension and per state. Keys: "<dimension>.<state>" -> { subject, body }.
-- ──────────────────────────────────────────────────────────────────────────

INSERT INTO public.platform_settings (key, value, description) VALUES
  ('abuse_notification_copy',
    '{
      "ai_cost.soft1":      { "subject_template": "You''ve reached 30% of your monthly AI usage", "body_intro": "Heads up — your tenant has used 30% of its monthly AI budget. You''re comfortably within range; this is just a friendly status update." },
      "ai_cost.soft2":      { "subject_template": "50% of your monthly AI usage", "body_intro": "You''re at the halfway mark on AI usage. Behind the scenes, the platform is starting to use lighter models for non-customer-facing tasks to stretch your budget. Customer chat is unchanged." },
      "ai_cost.hard":       { "subject_template": "Monthly AI limit reached — chat paused", "body_intro": "Customer-facing AI responses are paused for the rest of the billing period to protect your subscription value. Existing conversations remain readable. Request an override on /settings/usage if needed." },
      "chat_volume.soft1":  { "subject_template": "You''ve reached 30% of your monthly chat capacity", "body_intro": "Status update on chat volume. Responses may take a couple of extra seconds." },
      "chat_volume.soft2":  { "subject_template": "50% of your monthly chat capacity", "body_intro": "Chat volume is heading toward the cap. Response delays will increase slightly." },
      "chat_volume.hard":   { "subject_template": "Monthly chat limit reached", "body_intro": "Chat is paused for the rest of the billing period. Request an override on /settings/usage." },
      "email_volume.soft1": { "subject_template": "Email send rate slowing", "body_intro": "Your outbound email volume crossed 30% of your monthly allowance. Sends are queued with a brief delay." },
      "email_volume.soft2": { "subject_template": "Email queue extended", "body_intro": "Heads up — email send queuing now uses a longer delay. Transactional sends are unaffected." },
      "email_volume.hard":  { "subject_template": "Email volume cap reached", "body_intro": "Non-transactional email sends are paused for the rest of the period. Transactional sends (confirmations, password resets) continue." },
      "group_invite.soft1": { "subject_template": "Group invitations require confirmation", "body_intro": "You''re approaching your monthly group-invite cap. New batches require an explicit Send Now confirmation." },
      "group_invite.soft2": { "subject_template": "Group invitation batches above 20 need admin approval", "body_intro": "Larger group-invite batches now go through a quick admin pre-approval queue." },
      "group_invite.hard":  { "subject_template": "Group invite cap reached", "body_intro": "No new group invitations can be sent until next month. Existing groups remain active." },
      "rag_cap.approaching": { "subject_template": "Your RAG knowledge base is filling up", "body_intro": "You''re at 85% of your RAG capacity. Submit broadly-useful content for promotion to platform-wide knowledge — each promotion permanently adds 25 slots." },
      "rag_cap.at_cap":      { "subject_template": "RAG knowledge base at capacity", "body_intro": "New tenant-specific submissions will be auto-deleted if they aren''t broadly relevant. Globally promotable submissions continue to flow normally." }
    }'::JSONB,
    '§27.8 — operator-editable per-dimension/per-state notification copy. Keys "<dimension>.<state>" map to { subject_template, body_intro }.')
ON CONFLICT (key) DO NOTHING;
