// DIRECT IMPORTS OF THIS FILE OUTSIDE `tenant-client.ts` AND
// `platform-admin-client.ts` ARE A LINT FAILURE.
//
// To talk to the database, use one of:
//   - `tenantClient(ctx)` — for any operation acting on behalf of one tenant
//   - `withPlatformAdminAudit({ ... }, async (db, recordQuery) => { ... })`
//     — for the rare cross-tenant platform-admin operations
//
// The service-role key bypasses RLS, so an unaudited service-role client
// would silently defeat tenant isolation. See spec §5.4.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function createServiceRoleClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "createServiceRoleClient: NEXT_PUBLIC_SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY must be set. verifyEnvAtBoot() should " +
        "have caught this before the process started serving requests.",
    );
  }

  // Explicitly set Authorization so PostgREST receives the service-role JWT
  // as the Bearer token. Without this, Supabase JS v2 may omit the header
  // when there is no active auth session, causing PostgREST to fall back to
  // the anon role.
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${serviceKey}` } },
  });
}
