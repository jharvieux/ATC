-- §27 — Five-dimension SaaS abuse monitoring + cost controls.
--
-- 8 new tables + a tenant_settings column. Per §27.5 canonical schemas
-- verbatim (small deviation noted: the build prompt's prose said
-- billing_period was TEXT YYYY-MM; the spec schema is DATERANGE. We follow
-- the spec — DATERANGE supports annual billers' actual cycles, and the
-- helper currentBillingPeriod() builds a calendar-month range for monthly
-- billers).
--
-- RLS pattern:
--   • tenant_usage_metrics + tenant_rag_quotas → tenant-scoped read,
--     service-role writes (UPSERTs from the wrapper / counter increments).
--   • tenant_usage_overrides, usage_limit_events, tenant_rag_cap_events,
--     ai_call_log, abuse_signals, group_invite_pending_approval →
--     service-role only.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. tenant_usage_metrics — monthly-reset counters + per-dimension state
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.tenant_usage_metrics (
  id                              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  billing_period                  DATERANGE   NOT NULL,
  ai_cost_cents                   BIGINT      NOT NULL DEFAULT 0,
  chat_messages_count             INTEGER     NOT NULL DEFAULT 0,
  email_sent_count                INTEGER     NOT NULL DEFAULT 0,
  group_invitees_count            INTEGER     NOT NULL DEFAULT 0,
  email_sent_today                INTEGER     NOT NULL DEFAULT 0,
  email_sent_day_ref              DATE        NOT NULL DEFAULT CURRENT_DATE,
  ai_cost_limit_state             TEXT        NOT NULL DEFAULT 'ok'
                                    CHECK (ai_cost_limit_state IN ('ok','soft1','soft2','hard')),
  ai_cost_state_changed_at        TIMESTAMPTZ,
  chat_volume_limit_state         TEXT        NOT NULL DEFAULT 'ok'
                                    CHECK (chat_volume_limit_state IN ('ok','soft1','soft2','hard')),
  chat_volume_state_changed_at    TIMESTAMPTZ,
  email_volume_limit_state        TEXT        NOT NULL DEFAULT 'ok'
                                    CHECK (email_volume_limit_state IN ('ok','soft1','soft2','hard')),
  email_volume_state_changed_at   TIMESTAMPTZ,
  group_invite_limit_state        TEXT        NOT NULL DEFAULT 'ok'
                                    CHECK (group_invite_limit_state IN ('ok','soft1','soft2','hard')),
  group_invite_state_changed_at   TIMESTAMPTZ,
  last_recomputed_at              TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tenant_id, billing_period)
);

CREATE INDEX tenant_usage_metrics_tenant_period_idx
  ON public.tenant_usage_metrics(tenant_id, billing_period);

ALTER TABLE public.tenant_usage_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY tum_select_in_tenant ON public.tenant_usage_metrics
  FOR SELECT USING (auth_user_in_tenant(tenant_id));
CREATE POLICY tum_insert_service ON public.tenant_usage_metrics
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY tum_update_service ON public.tenant_usage_metrics
  FOR UPDATE USING (FALSE);
CREATE POLICY tum_delete_service ON public.tenant_usage_metrics
  FOR DELETE USING (FALSE);

GRANT SELECT ON public.tenant_usage_metrics TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_usage_metrics TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. tenant_rag_quotas — total cap with promotion rewards (NOT monthly)
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.tenant_rag_quotas (
  tenant_id                       UUID        PRIMARY KEY REFERENCES public.tenants(id) ON DELETE RESTRICT,
  base_cap                        INTEGER     NOT NULL,
  promoted_chunks_count           INTEGER     NOT NULL DEFAULT 0,
  current_tenant_chunks_count     INTEGER     NOT NULL DEFAULT 0,
  rag_state                       TEXT        NOT NULL DEFAULT 'ok'
                                    CHECK (rag_state IN ('ok','approaching','at_cap','over_cap')),
  rag_state_changed_at            TIMESTAMPTZ,
  updated_at                      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.tenant_rag_quotas ENABLE ROW LEVEL SECURITY;

CREATE POLICY trq_select_in_tenant ON public.tenant_rag_quotas
  FOR SELECT USING (auth_user_in_tenant(tenant_id));
CREATE POLICY trq_insert_service ON public.tenant_rag_quotas
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY trq_update_service ON public.tenant_rag_quotas
  FOR UPDATE USING (FALSE);
CREATE POLICY trq_delete_service ON public.tenant_rag_quotas
  FOR DELETE USING (FALSE);

GRANT SELECT ON public.tenant_rag_quotas TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_rag_quotas TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. tenant_usage_overrides — admin exception
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.tenant_usage_overrides (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  dimension             TEXT        NOT NULL CHECK (dimension IN (
                          'ai_cost','rag_cap','chat_volume','email_volume','group_invite'
                        )),
  tier_override         TEXT        CHECK (tier_override IN ('soft1','soft2','hard','base_cap')),
  threshold_value       BIGINT      NOT NULL,
  effective_from        DATE        NOT NULL,
  effective_to          DATE,
  reason                TEXT        NOT NULL,
  approved_by_user_id   UUID        NOT NULL REFERENCES public.users(id),
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX tenant_usage_overrides_active_idx
  ON public.tenant_usage_overrides(tenant_id, dimension)
  WHERE effective_to IS NULL OR effective_to > CURRENT_DATE;

ALTER TABLE public.tenant_usage_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY tuo_select_service ON public.tenant_usage_overrides
  FOR SELECT USING (FALSE);
CREATE POLICY tuo_insert_service ON public.tenant_usage_overrides
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY tuo_update_service ON public.tenant_usage_overrides
  FOR UPDATE USING (FALSE);
CREATE POLICY tuo_delete_service ON public.tenant_usage_overrides
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_usage_overrides TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. usage_limit_events — audit trail of state transitions
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.usage_limit_events (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID        NOT NULL REFERENCES public.tenants(id),
  dimension               TEXT        NOT NULL,
  from_state              TEXT        NOT NULL,
  to_state                TEXT        NOT NULL,
  metric_value            BIGINT      NOT NULL,
  threshold_crossed       BIGINT      NOT NULL,
  triggered_at            TIMESTAMPTZ DEFAULT NOW(),
  notification_sent_to    TEXT[],
  resolution_action       TEXT,
  resolved_at             TIMESTAMPTZ,
  resolved_by_user_id     UUID        REFERENCES public.users(id)
);

CREATE INDEX usage_limit_events_tenant_idx
  ON public.usage_limit_events(tenant_id, triggered_at DESC);

ALTER TABLE public.usage_limit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY ule_select_service ON public.usage_limit_events
  FOR SELECT USING (FALSE);
CREATE POLICY ule_insert_service ON public.usage_limit_events
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY ule_update_service ON public.usage_limit_events
  FOR UPDATE USING (FALSE);
CREATE POLICY ule_delete_service ON public.usage_limit_events
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.usage_limit_events TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 5. tenant_rag_cap_events — RAG-specific audit
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.tenant_rag_cap_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL REFERENCES public.tenants(id),
  event_type      TEXT        NOT NULL CHECK (event_type IN (
                    'submission_auto_deleted','declined_chunk_auto_deleted',
                    'promoted_cap_increased','state_transition','manual_cap_adjustment'
                  )),
  chunk_id        UUID,
  queue_id        UUID,
  cap_before      INTEGER,
  cap_after       INTEGER,
  count_before    INTEGER,
  count_after     INTEGER,
  reason          TEXT,
  occurred_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX tenant_rag_cap_events_tenant_idx
  ON public.tenant_rag_cap_events(tenant_id, occurred_at DESC);

ALTER TABLE public.tenant_rag_cap_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY trce_select_service ON public.tenant_rag_cap_events
  FOR SELECT USING (FALSE);
CREATE POLICY trce_insert_service ON public.tenant_rag_cap_events
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY trce_update_service ON public.tenant_rag_cap_events
  FOR UPDATE USING (FALSE);
CREATE POLICY trce_delete_service ON public.tenant_rag_cap_events
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_rag_cap_events TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 6. ai_call_log — per-call AI cost attribution per §27.12
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.ai_call_log (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES public.tenants(id),
  conversation_id     UUID        REFERENCES public.conversations(id),
  user_id             UUID        REFERENCES public.users(id),
  model               TEXT        NOT NULL,
  vendor              TEXT        NOT NULL CHECK (vendor IN ('anthropic','openai')),
  purpose             TEXT        NOT NULL CHECK (purpose IN (
                        'chat_main','chat_supervisor','entity_extraction',
                        'memory_extraction','rag_normalization','rag_pii_redaction',
                        'rag_relevance_scoring','persona_addendum_screen',
                        'forum_moderation','precruise_generation','quote_narrative',
                        'embedding','content_normalization','other'
                      )),
  input_tokens        INTEGER     NOT NULL,
  output_tokens       INTEGER     NOT NULL,
  cost_estimate_cents BIGINT      NOT NULL,
  latency_ms          INTEGER,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ai_call_log_tenant_recent_idx
  ON public.ai_call_log(tenant_id, created_at DESC);
CREATE INDEX ai_call_log_created_idx
  ON public.ai_call_log(created_at);

ALTER TABLE public.ai_call_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_call_log_select_service ON public.ai_call_log
  FOR SELECT USING (FALSE);
CREATE POLICY ai_call_log_insert_service ON public.ai_call_log
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY ai_call_log_update_service ON public.ai_call_log
  FOR UPDATE USING (FALSE);
CREATE POLICY ai_call_log_delete_service ON public.ai_call_log
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_call_log TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 7. abuse_signals — Part 5 abuse-signal consumer surface
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.abuse_signals (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID        NOT NULL REFERENCES public.tenants(id),
  signal_kind                 TEXT        NOT NULL CHECK (signal_kind IN (
                                'rag_pii_recurring','anon_chat_burst',
                                'quality_low_approval','duplicate_high_rate',
                                'email_bounce_rate'
                              )),
  detail                      JSONB       NOT NULL,
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  acknowledged_at             TIMESTAMPTZ,
  acknowledged_by_user_id     UUID        REFERENCES public.users(id)
);

CREATE INDEX abuse_signals_admin_queue_idx
  ON public.abuse_signals(tenant_id, created_at DESC)
  WHERE acknowledged_at IS NULL;

ALTER TABLE public.abuse_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY abuse_signals_select_service ON public.abuse_signals
  FOR SELECT USING (FALSE);
CREATE POLICY abuse_signals_insert_service ON public.abuse_signals
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY abuse_signals_update_service ON public.abuse_signals
  FOR UPDATE USING (FALSE);
CREATE POLICY abuse_signals_delete_service ON public.abuse_signals
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.abuse_signals TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 8. group_invite_pending_approval — soft2 admin-preapproval queue
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.group_invite_pending_approval (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID        NOT NULL REFERENCES public.tenants(id),
  group_id               UUID        NOT NULL REFERENCES public.groups(id),
  requested_by_user_id   UUID        NOT NULL REFERENCES public.users(id),
  invitee_count          INTEGER     NOT NULL,
  payload                JSONB       NOT NULL,
  status                 TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','approved','denied')),
  reviewed_by_user_id    UUID        REFERENCES public.users(id),
  reviewed_at            TIMESTAMPTZ,
  requested_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX gipa_pending_idx
  ON public.group_invite_pending_approval(requested_at DESC)
  WHERE status = 'pending';

ALTER TABLE public.group_invite_pending_approval ENABLE ROW LEVEL SECURITY;

CREATE POLICY gipa_select_service ON public.group_invite_pending_approval
  FOR SELECT USING (FALSE);
CREATE POLICY gipa_insert_service ON public.group_invite_pending_approval
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY gipa_update_service ON public.group_invite_pending_approval
  FOR UPDATE USING (FALSE);
CREATE POLICY gipa_delete_service ON public.group_invite_pending_approval
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.group_invite_pending_approval TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 9. tenant_settings — email bounce-rate side-channel pause flag
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.tenant_settings
  ADD COLUMN IF NOT EXISTS email_paused_due_to_bounce_rate BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.tenant_settings.email_paused_due_to_bounce_rate IS
  '§27.4.4 / §27.6: when TRUE, non-transactional email sends are refused regardless of monthly volume state. Independent side channel managed by the email-bounce-rate-monitor cron.';

-- ──────────────────────────────────────────────────────────────────────────
-- 10. rag_submissions — extend review_status CHECK to include 'auto_deleted'
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.rag_submissions
  DROP CONSTRAINT IF EXISTS rag_submissions_review_status_check;

ALTER TABLE public.rag_submissions
  ADD CONSTRAINT rag_submissions_review_status_check
  CHECK (review_status IN (
    'pending','ready_for_review','approved','rejected','superseded','auto_deleted'
  ));
