// Platform-internal API — called by the RAG nightly reconcile cron (§8.3).
// Auth: Bearer token in Authorization header (MAIN_APP_ADMIN_API_KEY).
// Returns all tenants the RAG service needs to know about.
// Not exposed to end users; not behind assertPermission.
//
// Service-role import permitted: platform-internal admin endpoint.
// This file is in the no-direct-service-role-import allowlist.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { constantTimeEqual } from "@/lib/auth/constant-time-equal";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function GET(req: Request): Promise<Response> {
  const apiKey = process.env.MAIN_APP_ADMIN_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "server_misconfigured" }, { status: 500 });
  }

  // Constant-time compare: a plain `!==` on the bearer secret leaks the key
  // byte-by-byte via response timing (D-091, #397).
  const auth = req.headers.get("authorization") ?? "";
  if (!constantTimeEqual(auth, `Bearer ${apiKey}`)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("tenants")
    .select("id, status, tenant_type, display_name, source_revision");

  if (error) {
    return dbErrorResponse();
  }

  return Response.json({ tenants: data });
}
