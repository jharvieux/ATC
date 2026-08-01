// Platform-internal API — called by the RAG nightly reconcile cron (§8.3).
// Auth: Bearer token in Authorization header (MAIN_APP_ADMIN_API_KEY).
// Returns all tenants the RAG service needs to know about.
// Not exposed to end users; not behind assertPermission.
//
// Service-role import permitted: platform-internal admin endpoint.
// This file is in the no-direct-service-role-import allowlist.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { adminApiKeySecrets, matchesAdminApiKey } from "@/lib/auth/admin-api-key";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function GET(req: Request): Promise<Response> {
  if (adminApiKeySecrets().length === 0) {
    return Response.json({ error: "server_misconfigured" }, { status: 500 });
  }

  // Constant-time compare (a plain `!==` leaks the key byte-by-byte via
  // response timing — D-091, #397) against the _CURRENT/_PREVIOUS rotation
  // set (#2002, D-091 #28).
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!matchesAdminApiKey(token)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("tenants")
    .select("id, status, tenant_type, display_name, source_revision");

  if (error) {
    return dbErrorResponse(error);
  }

  return Response.json({ tenants: data });
}
