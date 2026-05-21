-- Migration: table grants for authenticated and anon roles
--
-- Postgres permission model is two-stage: a role first needs the basic
-- table privilege (GRANT SELECT/INSERT/etc.), then RLS policies filter
-- which rows are visible. Without the GRANT, RLS is irrelevant — the
-- role can't access the table at all.
--
-- Supabase normally sets these up via ALTER DEFAULT PRIVILEGES in the
-- project's initial setup, but the atc-main project was provisioned in
-- a way that left only metadata grants (REFERENCES, TRIGGER, TRUNCATE)
-- in place. We grant explicitly here so the policies in 0003 can do
-- their job.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenants TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users   TO authenticated;

-- tier_definitions is a non-tenant-scoped lookup table; anyone signed
-- in can read it. Writes go through service-role admin paths.
GRANT SELECT ON public.tier_definitions TO authenticated, anon;
