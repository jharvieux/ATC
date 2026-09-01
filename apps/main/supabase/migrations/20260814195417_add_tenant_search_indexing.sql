-- Migration: add_tenant_search_indexing
-- Version:   20260814195417
-- Generated: 2026-08-14T19:54:17Z by scripts/new-migration.sh
-- Branch:    feature/sweep-seo-2058
-- Worktree:  atc-sweep-seo-2058
--
-- Adds an opt-in for verified Agency custom domains. The false default
-- preserves D-368's noindex behavior for every existing and future tenant.
-- Rollback: drop search_indexing_enabled after all application readers have
-- been removed in a separate contract migration.

ALTER TABLE public.tenants
  ADD COLUMN search_indexing_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.tenants.search_indexing_enabled IS
  'Tenant opt-in to index a verified custom domain; platform subdomains ignore this setting.';
