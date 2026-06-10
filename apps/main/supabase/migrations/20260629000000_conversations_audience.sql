-- #902 — TA-mode chat: conversation audience discriminator.
--
-- Phase 1 of the BYO dual-role persona track (MEMORY D-193/D-195,
-- docs/byo-agents/902-ta-mode-chat-design.md). Tenant members
-- (tenant_owner/agent) get a TA-register chat in the dashboard; those
-- conversations must never mix into customer chat history, CRM timelines,
-- or customer-facing conversation lists — and a TA must not be able to
-- continue a customer conversation in TA register (or vice versa).
--
-- Expand-only (§38 step 1; no contract phase — nothing is dropped).
-- TEXT + CHECK rather than an enum: matches existing discriminator
-- conventions on this table (status) and avoids enum-alter migrations
-- when audiences grow.

ALTER TABLE public.conversations
  ADD COLUMN audience TEXT NOT NULL DEFAULT 'customer'
  CONSTRAINT conversations_audience_check
    CHECK (audience IN ('customer', 'tenant_member'));

COMMENT ON COLUMN public.conversations.audience IS
  'Who the persona is speaking to: ''customer'' (existing concierge) or '
  '''tenant_member'' (TA-mode dashboard chat, #902). Server-derived from '
  'member role at write time — never client-supplied.';

-- No index added: every read path filters audience alongside tenant_id +
-- user_id (already indexed); audience alone is never the scan key.
