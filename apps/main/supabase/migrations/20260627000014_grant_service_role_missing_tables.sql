-- §26 — Restore service_role grants on tables created without them.
--
-- assertPlatformAdmin() reads public.platform_admins via the service-role
-- client. In production that SELECT returned PostgREST 403 ("permission denied
-- for table") because platform_admins — and 12 other tables — were created
-- WITHOUT the GRANT that every other app table carries. The admin gate then
-- failed closed (500 platform_admins_lookup_failed) on every /api/admin/*
-- route, taking down the entire platform-admin surface.
--
-- Root cause: these tables' create-migrations omitted the
-- "GRANT ... TO service_role" block the rest of the schema uses. This project
-- does not rely on Supabase default privileges (anon has no grants anywhere),
-- so nothing backfilled them. service_role is server-only and RLS-bypassing;
-- the app's platformAdminClient and tenantClient paths both ultimately need it.
--
-- This migration re-grants the standard CRUD set to service_role only. RLS is
-- unchanged. authenticated/anon grants are deliberately NOT touched here:
--   - platform_admins denies authenticated by design (service_role only).
--   - the remaining tables' authenticated-access needs are reviewed separately.
-- schema_migrations is excluded — it is Postgres-internal and never queried by
-- the application.

grant select, insert, update, delete on table
  public.platform_admins,
  public.bug_submissions,
  public.feature_requests,
  public.help_sessions,
  public.help_doc_versions,
  public.general_pricing_ranges,
  public.price_watches,
  public.customer_bug_submission_counters,
  public.apify_spend_ledger,
  public.cruisemapper_url_inventory,
  public.destination_images,
  public.destination_images_cache,
  public.pricing_cache
to service_role;
