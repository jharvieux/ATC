-- Migration: messages_source_email
-- Version:   20260722000014
-- Generated: 2026-07-09T19:00:19Z by scripts/new-migration.sh
-- Branch:    feature/sweep-email2-1728
-- Worktree:  agent-a607b876dd620bee2
--
-- #1728 (inbound persona email Phase 2) — expand-only.
--
-- Adds provenance to messages so a customer's inbound persona-address reply
-- (docs/design/inbound-persona-email.md) can be attached to the CRM
-- conversation timeline as a role='user' message tagged source='email'.
--
--   source            — provenance marker. NULL for the existing agent/chat
--                       messages; 'email' for inbound-email attachments. The
--                       CHECK permits NULL (NULL IN (...) is unknown, which a
--                       CHECK treats as satisfied) and can be widened later
--                       (e.g. 'sms') by a future expand migration.
--   source_message_id — the provider's inbound message id for source='email'
--                       rows. This is the idempotency anchor: the webhook may
--                       redeliver (or two deliveries may race), and the partial
--                       UNIQUE index makes the attach a no-op on the 23505 the
--                       second insert raises (D-091 #24). NULL for all non-email
--                       messages, so the partial index stays tiny.
--
-- No RLS/grant change: new columns inherit the table's policies and the
-- table-level GRANTs already cover them, so no snapshot regen is required.

ALTER TABLE public.messages
  ADD COLUMN source            TEXT,
  ADD COLUMN source_message_id TEXT;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_source_check CHECK (source IN ('email'));

CREATE UNIQUE INDEX messages_source_message_id_uidx
  ON public.messages(source_message_id)
  WHERE source_message_id IS NOT NULL;
