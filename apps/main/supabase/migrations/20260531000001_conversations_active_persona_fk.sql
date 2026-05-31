-- §9.8 / issue #455 — Add FK constraint on conversations.active_persona_id.
--
-- The column was added without a FK (intentional scaffold), leaving it possible
-- to store a stale persona UUID after a persona is deleted. This migration:
--   1. Nulls out any rows where active_persona_id references a persona that no
--      longer exists (safe backfill before constraint is added).
--   2. Adds the FK with ON DELETE SET NULL so future persona deletes keep
--      conversations valid instead of violating the constraint.

UPDATE public.conversations
SET    active_persona_id = NULL
WHERE  active_persona_id IS NOT NULL
  AND  active_persona_id NOT IN (SELECT id FROM public.personas);

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_active_persona_id_fkey
  FOREIGN KEY (active_persona_id)
  REFERENCES public.personas(id)
  ON DELETE SET NULL;
