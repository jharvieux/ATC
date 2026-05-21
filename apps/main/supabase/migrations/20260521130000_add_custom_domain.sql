-- Migration: add custom_domain to tenants
-- Spec refs: §1.4 (tenant resolution), BP04 (tenant resolution middleware)
--
-- custom_domain stores the bare hostname (e.g. "travel.example.com") that
-- maps to this tenant. Nullable — tenants without a custom domain are only
-- reachable via their subdomain (slug.PLATFORM_PRIMARY_DOMAIN).
-- Must be unique: two tenants cannot share the same custom domain.
--
-- RLS deviation: custom_domain is a column on the existing tenants table
-- which already has full RLS coverage from migration 0003. No policy change
-- needed here.

ALTER TABLE public.tenants
  ADD COLUMN custom_domain TEXT UNIQUE;

COMMENT ON COLUMN public.tenants.custom_domain IS
  'Bare hostname for custom domain routing (e.g. travel.example.com). '
  'Nullable. Set via platform-admin tooling when a tenant provisions a custom domain.';

CREATE INDEX tenants_custom_domain_idx
  ON public.tenants(custom_domain)
  WHERE custom_domain IS NOT NULL;
