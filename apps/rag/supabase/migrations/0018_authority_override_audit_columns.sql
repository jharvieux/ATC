-- §33.12 — Authority-override audit columns.
--
-- When a platform admin sets authority_manual_override via the new
-- /api/admin/set-authority-override endpoint, we record:
--   - The reason (free text, capped at 500 chars at the API layer)
--   - The timestamp it was set
--
-- Both columns are nullable and reset to NULL when the override is
-- cleared. The audit_log row on the main app side (written through
-- withPlatformAdminAudit) is the authoritative who/when record; these
-- columns surface on the chunk for quick admin-UI rendering.

ALTER TABLE public.knowledge_chunks
  ADD COLUMN IF NOT EXISTS authority_override_reason TEXT,
  ADD COLUMN IF NOT EXISTS authority_override_set_at TIMESTAMPTZ;

-- The set_at index supports the admin UI "show recent overrides" view.
CREATE INDEX IF NOT EXISTS knowledge_chunks_authority_override_set_at_idx
  ON public.knowledge_chunks (authority_override_set_at DESC)
  WHERE authority_override_set_at IS NOT NULL;
