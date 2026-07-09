-- Migration: inbound_emails
-- Version:   20260709143339
-- Generated: 2026-07-09T14:33:39Z by scripts/new-migration.sh
-- Branch:    feature/sweep-email-890
-- Worktree:  agent-a07583e8e4524f2e9
--
-- #890 Phase 1 (docs/design/inbound-persona-email.md) — persist inbound email
-- received on persona addresses (marcus@ai-travelconcierge.com etc.) via the
-- Resend inbound webhook. tenant_id/contact_id are nullable: resolution happens
-- at ingest (References-header match against email_log, else unique-sender
-- match) and unresolved mail is kept for the platform-admin list instead of
-- being dropped. provider_message_id is UNIQUE — the webhook's dedup/replay
-- anchor (row written only after processing completes, D-091 #10/#24).
-- Expand-only; no rollback concerns (new table, no readers before this PR).

CREATE TABLE public.inbound_emails (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_message_id     TEXT        NOT NULL,
  tenant_id               UUID        REFERENCES public.tenants(id),
  contact_id              UUID        REFERENCES public.contacts(id),
  from_email              TEXT        NOT NULL,
  to_email                TEXT        NOT NULL,
  subject                 TEXT,
  text_body               TEXT,
  resolution              TEXT        NOT NULL CHECK (resolution IN (
    'references','sender','unresolved'
  )),
  -- Provider SPF/DKIM verdicts, recorded for abuse triage (design §security).
  spf_result              TEXT,
  dkim_result             TEXT,
  raw_payload             JSONB       NOT NULL,
  forwarded_email_log_id  UUID        REFERENCES public.email_log(id),
  received_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX inbound_emails_provider_message_id_uidx
  ON public.inbound_emails(provider_message_id);
CREATE INDEX inbound_emails_tenant_received_idx
  ON public.inbound_emails(tenant_id, received_at);

-- RLS — tenant members read their tenant's rows; writes are service_role only
-- (webhook handler). Unresolved rows (tenant_id NULL) are invisible to tenants
-- and surface only via the service-role platform-admin route.
ALTER TABLE public.inbound_emails ENABLE ROW LEVEL SECURITY;

-- Mirrors audit_log_select_in_tenant: initplan-wrapped auth.uid() (#1482),
-- tenant membership via the auth_user_in_tenant helper, and an explicit
-- tenant_id IS NOT NULL so unresolved rows never match any tenant.
CREATE POLICY inbound_emails_select ON public.inbound_emails
  FOR SELECT USING (
    ((select auth.uid()) IS NOT NULL)
    AND (tenant_id IS NOT NULL)
    AND auth_user_in_tenant(tenant_id)
  );
CREATE POLICY inbound_emails_insert_service ON public.inbound_emails
  FOR INSERT WITH CHECK (FALSE);
CREATE POLICY inbound_emails_update_service ON public.inbound_emails
  FOR UPDATE USING (FALSE);
CREATE POLICY inbound_emails_delete_service ON public.inbound_emails
  FOR DELETE USING (FALSE);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbound_emails TO service_role;
GRANT SELECT ON public.inbound_emails TO authenticated;
