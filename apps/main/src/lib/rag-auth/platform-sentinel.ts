// §15.16 / BP09 follow-up — PLATFORM sentinel tenant for genuinely cross-
// tenant service JWTs.
//
// The rag verifier (apps/rag/src/lib/auth/verify-service-jwt.ts) requires
// the JWT's tenant_id to exist in tenant_registry_shadow with status='active'.
// Most callers carry an affected-tenant id (e.g. rag-tenant-scoped-purge
// targets a specific terminated tenant). A handful of crons are genuinely
// cross-tenant (CruiseMapper itinerary refresh writes content for ALL
// tenants; image-asset-recorder records hot-linked images for the global
// content pool). Those callers carry this sentinel.
//
// Matches:
//   apps/main/src/lib/ai/call-wrapper.ts PLATFORM_TENANT_ID
//   apps/main/src/lib/abuse/snapshot.ts PLATFORM_TENANT_ID
//   apps/rag/supabase/migrations/0015_platform_sentinel_tenant.sql seed
//
// Pair with service_identifier='platform-admin' so rag's per-endpoint
// authorization checks (e.g. /api/admin/tenant-chunk-counts checks for
// 'platform-admin') accept the caller.

export const PLATFORM_SENTINEL_TENANT_ID = "00000000-0000-0000-0000-000000000000";
