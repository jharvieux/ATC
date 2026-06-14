-- #1052 — Security advisor (rls_disabled_in_public): enable RLS on 7 platform-
-- scoped public tables that had RLS OFF.
--
-- None of these carry a tenant_id; all reads/writes go through service_role
-- (adapters, Inngest crons, the groups hero-image helper, platform-admin
-- reconciliation). service_role has BYPASSRLS, so enabling RLS with ZERO
-- policies is default-deny for anon/authenticated over the Data API while every
-- legitimate service-role path is unaffected. This mirrors the established
-- pattern for tier_definitions / vendor_health / personal_access_tokens.
--
-- anon/authenticated never had SELECT/DML here (only stray REFERENCES/TRIGGER/
-- TRUNCATE), so there is no live read path to break — this closes the advisor's
-- "RLS disabled on a public table" finding, not an active leak.
--
-- Each table is allowlisted in db/rls-exceptions.{sql,txt} (rls:coverage would
-- otherwise flag RLS-on-zero-policies as a silent-deny trap).

-- schema_migrations is the db-migrate ledger (created by scripts/db-migrate.ts,
-- not a migration file). IF EXISTS guards the supabase-CLI push path where the
-- public ledger table may be absent.
ALTER TABLE IF EXISTS public.schema_migrations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.apify_spend_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cruisemapper_url_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricing_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.destination_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.destination_images_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_review_queue ENABLE ROW LEVEL SECURITY;
