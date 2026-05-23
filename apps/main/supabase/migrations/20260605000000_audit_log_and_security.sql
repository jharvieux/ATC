-- §26 — Audit log + partial GIN + forensics complement tables.
--
-- This migration finally creates the audit_log table that every prior BP has
-- been stubbing to console.warn under [audit-log:STUB] (D-036 / D-053 / D-056
-- / D-057 / D-058). After this migration lands, every stub writer in the
-- codebase is swept to real INSERTs (see BP26 PR for the touched files).
--
-- §26.5 canonical schema, verbatim columns + check.
-- §26.3a.3 partial GIN index on changes WHERE actor_type='admin' — the
-- partial WHERE is load-bearing: user-action writes are the hot path and
-- must NOT pay the GIN write cost.

-- ──────────────────────────────────────────────────────────────────────────
-- 1. audit_log — §26.5 canonical
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.audit_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        REFERENCES public.tenants(id),
  actor_user_id   UUID        REFERENCES public.users(id),
  actor_type      TEXT        CHECK (actor_type IN ('user','system','admin','ai')),
  action          TEXT        NOT NULL,
  resource_type   TEXT        NOT NULL,
  resource_id     UUID,
  changes         JSONB,
  context         JSONB,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_log_tenant_idx   ON public.audit_log(tenant_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx    ON public.audit_log(actor_user_id, occurred_at DESC);
CREATE INDEX audit_log_resource_idx ON public.audit_log(resource_type, resource_id);

-- §26.3a.3 partial GIN — admin rows only.
CREATE INDEX audit_log_changes_admin_gin_idx
  ON public.audit_log
  USING GIN (changes jsonb_path_ops)
  WHERE actor_type = 'admin';

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- Tenant-scoped read: members can see their tenant's audit rows.
-- All writes are service_role only (every audit writer goes through the
-- service-role db — assertPermission, withPlatformAdminAudit, factories,
-- webhook handlers, retention crons).
CREATE POLICY audit_log_select_in_tenant ON public.audit_log
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND tenant_id IS NOT NULL
    AND auth_user_in_tenant(tenant_id)
  );
CREATE POLICY audit_log_insert_service ON public.audit_log
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY audit_log_update_service ON public.audit_log
  FOR UPDATE USING (FALSE);
-- DELETE is service-role only and gated by the retention cron (§26.5 7y).
CREATE POLICY audit_log_delete_service ON public.audit_log
  FOR DELETE USING (FALSE);

GRANT SELECT ON public.audit_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.audit_log TO service_role;

COMMENT ON TABLE public.audit_log IS
  '§26.5 canonical audit log. 7-year retention. Significant actions only — IDs not PII.';
COMMENT ON COLUMN public.audit_log.actor_type IS
  'user | system | admin | ai. admin rows get the partial GIN index for JSONB introspection.';

-- ──────────────────────────────────────────────────────────────────────────
-- 2. complaints — §26.5a tenant_complaint snapshot trigger surface
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.complaints (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID        NOT NULL REFERENCES public.tenants(id),
  subject               TEXT        NOT NULL,
  body                  TEXT        NOT NULL,
  submitted_by_user_id  UUID        REFERENCES public.users(id),
  submitted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status                TEXT        NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','in_review','resolved')),
  resolved_at           TIMESTAMPTZ,
  forensics_snapshot_id UUID  -- bare UUID; forensics_log is tenant-blind
);

CREATE INDEX complaints_tenant_status_idx
  ON public.complaints(tenant_id, status, submitted_at DESC);

ALTER TABLE public.complaints ENABLE ROW LEVEL SECURITY;

CREATE POLICY complaints_select_in_tenant ON public.complaints
  FOR SELECT USING (auth_user_in_tenant(tenant_id));
CREATE POLICY complaints_insert_in_tenant ON public.complaints
  FOR INSERT WITH CHECK (auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id));
CREATE POLICY complaints_update_service ON public.complaints
  FOR UPDATE USING (FALSE);
CREATE POLICY complaints_delete_service ON public.complaints
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT ON public.complaints TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.complaints TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. security_incidents — §26.5a snapshot trigger + §26.7 declaration
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.security_incidents (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  severity               TEXT        NOT NULL
                           CHECK (severity IN ('low','medium','high','critical')),
  summary                TEXT        NOT NULL,
  affected_tenant_ids    UUID[]      NOT NULL DEFAULT '{}',
  declared_by_user_id    UUID        REFERENCES public.users(id),
  declared_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status                 TEXT        NOT NULL DEFAULT 'declared'
                           CHECK (status IN ('declared','contained','resolved','postmortem')),
  forensics_snapshot_id  UUID
);

CREATE INDEX security_incidents_severity_idx
  ON public.security_incidents(severity, declared_at DESC);

ALTER TABLE public.security_incidents ENABLE ROW LEVEL SECURITY;

-- Service-role only — declarations come from /api/admin/security-incident.
CREATE POLICY security_incidents_select_service ON public.security_incidents
  FOR SELECT USING (FALSE);
CREATE POLICY security_incidents_insert_service ON public.security_incidents
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY security_incidents_update_service ON public.security_incidents
  FOR UPDATE USING (FALSE);
CREATE POLICY security_incidents_delete_service ON public.security_incidents
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.security_incidents TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. tenant_settings.forensics_on_export — §26.5a CCPA export opt-in
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.tenant_settings
  ADD COLUMN IF NOT EXISTS forensics_on_export BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.tenant_settings.forensics_on_export IS
  '§26.5a: opt-in per-tenant. When TRUE, CCPA export jobs capture a forensics snapshot of what was exported.';

-- ──────────────────────────────────────────────────────────────────────────
-- 5. auth_attempts — §26.6 monitoring source (auth-failure-monitor cron)
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE public.auth_attempts (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ip           TEXT        NOT NULL,
  email_hash   TEXT,
  outcome      TEXT        NOT NULL CHECK (outcome IN ('success','failure')),
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX auth_attempts_ip_recent_idx
  ON public.auth_attempts(ip, occurred_at DESC)
  WHERE outcome = 'failure';

CREATE INDEX auth_attempts_purge_idx
  ON public.auth_attempts(occurred_at);

ALTER TABLE public.auth_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY auth_attempts_select_service ON public.auth_attempts
  FOR SELECT USING (FALSE);
CREATE POLICY auth_attempts_insert_service ON public.auth_attempts
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY auth_attempts_update_service ON public.auth_attempts
  FOR UPDATE USING (FALSE);
CREATE POLICY auth_attempts_delete_service ON public.auth_attempts
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.auth_attempts TO service_role;
