-- §9.8 / issue #455 — wire the deferred persona foreign keys.
--
-- conversations.active_persona_id and messages.persona_id were added as bare
-- UUID columns in 20260521150000_conversations_messages.sql, with a TODO noting
-- the FK would land "when the personas table lands". The personas table did not
-- exist yet, so 20260531000001_conversations_active_persona_fk.sql was an empty
-- placeholder. personas now exists (20260627000020), so the FKs are added here.
--
-- ON DELETE SET NULL: removing a persona (not an app operation today — the 7 are
-- fixed and authenticated DELETE is denied — but possible via service_role) must
-- NOT cascade-delete conversation/message history. The reference just nulls out.
--
-- The two prior migrations are applied history and are intentionally left
-- untouched; this migration supersedes their TODO/placeholder. Resolves #455.

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_active_persona_id_fkey
  FOREIGN KEY (active_persona_id) REFERENCES public.personas(id) ON DELETE SET NULL;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_persona_id_fkey
  FOREIGN KEY (persona_id) REFERENCES public.personas(id) ON DELETE SET NULL;

CREATE INDEX conversations_active_persona_id_idx
  ON public.conversations (active_persona_id)
  WHERE active_persona_id IS NOT NULL;

CREATE INDEX messages_persona_id_idx
  ON public.messages (persona_id)
  WHERE persona_id IS NOT NULL;
