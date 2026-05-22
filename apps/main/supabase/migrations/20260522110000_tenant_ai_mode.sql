-- §9.10.3 — AI Mode and Background AI columns on tenants
-- Both default to the spec's defaults: autonomous + background ON.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS ai_mode TEXT NOT NULL DEFAULT 'autonomous'
    CHECK (ai_mode IN ('autonomous', 'draft_only', 'disabled'));

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS background_ai_enabled BOOLEAN NOT NULL DEFAULT TRUE;
