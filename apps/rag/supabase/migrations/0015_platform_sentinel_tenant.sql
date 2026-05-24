-- §15.16 / BP09 follow-up — Seed the PLATFORM sentinel tenant in
-- tenant_registry_shadow so service JWTs minted by genuinely cross-tenant
-- crons (CruiseMapper itinerary ingest, image-asset-recorder, etc.) can
-- carry tenant_id=PLATFORM and still pass the verifier's
-- tenant-in-shadow + status='active' checks.
--
-- The sentinel UUID matches the existing PLATFORM_TENANT_ID used in
-- apps/main/src/lib/ai/call-wrapper.ts (all-zero UUID).
--
-- The tenant_registry_shadow reconcile cron compares main's tenants
-- against this table. The sentinel does NOT exist in main.tenants — when
-- the reconcile runs, it'll log "in shadow, absent from main" for this
-- row. That's expected and noted in the sentinel description; the cron's
-- behaviour is "log only," so no harm.

INSERT INTO public.tenant_registry_shadow (
  tenant_id,
  status,
  tenant_type,
  display_name,
  source_revision
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  'active',
  'platform',
  'PLATFORM (sentinel for cross-tenant service JWTs — DO NOT DELETE)',
  0
)
ON CONFLICT (tenant_id) DO NOTHING;
