-- #1190 / BP34 — per-tenant override for the import auto-accept confidence
-- threshold. The reader (apps/main/src/lib/import/auto-accept.ts loadThreshold)
-- has always queried this column; it was never created, so every tenant
-- silently fell through to the platform_settings default
-- (bp34_import_auto_accept_threshold_default). Adding it makes the per-tenant
-- override actually work.
--
-- Nullable with no default: NULL = "no override" → loadThreshold falls through
-- to the platform default (preserving today's behavior for existing tenants).
-- The value is a confidence in [0,1]; loadThreshold also clamps, the CHECK
-- documents the intended range.
ALTER TABLE public.tenant_settings
  ADD COLUMN IF NOT EXISTS import_auto_accept_threshold NUMERIC
    CHECK (
      import_auto_accept_threshold IS NULL
      OR (import_auto_accept_threshold >= 0 AND import_auto_accept_threshold <= 1)
    );
