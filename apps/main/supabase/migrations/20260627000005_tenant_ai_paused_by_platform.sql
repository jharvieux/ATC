-- §10.6 — per-tenant AI kill switch column.
--
-- Spec: "platform admin can pause AI responses globally or per-tenant."
-- Pre-fix the per-tenant pause was implemented at /api/admin/tenant/[id]/pause-ai
-- by flipping tenants.status to 'suspended'. Two problems with that:
--   1. The chat route doesn't check tenants.status, so the endpoint had
--      no actual effect on the AI customer chat path.
--   2. tenants.status='suspended' is a tenant-lifecycle action (per §3.2:
--      no new bookings, read-only) — way broader than the AI-misbehavior
--      scenario §10.6 describes ("model misbehavior, prompt injection
--      campaign, etc.").
--
-- New column: a dedicated boolean for the AI-scope pause. Flipped by
-- platform admin only; read by the chat and help-AI routes alongside the
-- existing platform_settings.ai_kill_switch_engaged global check.
--
-- RLS: tenants table is platform-admin-owned anyway; no policy change
-- needed. Tenant-side UI does NOT expose this — the tenant's own
-- ai_mode='disabled' setting is the customer-controlled equivalent.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS ai_paused_by_platform BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.tenants.ai_paused_by_platform IS
  '§10.6 per-tenant AI kill switch. TRUE = customer-facing chat and help-AI return the §10.6 fallback message without calling Anthropic. Flipped by platform admin only.';
