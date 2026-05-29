// D-041 follow-up — Admin list endpoint for the rag-side reconcile cron.
//
// Mirrors /api/admin/tenants (same MAIN_APP_ADMIN_API_KEY bearer auth, same
// shape: an array under a top-level key). Returns the FULL platform_settings
// table (key/value/source_revision/updated_at) so the cron can diff against
// its local replica.
//
// Privacy: this endpoint is reachable only with the platform admin bearer
// token; it's NOT exposed to tenant JWTs. The deny-list value is returned
// here because this is the same trust boundary that already reads tenant
// PII (cross-tenant admin); the rag-side cron, however, applies an
// allowlist filter symmetric to publish-platform-event.ts and discards
// non-sync-eligible keys before writing them into the replica.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { constantTimeEqual } from "@/lib/auth/constant-time-equal";

export async function GET(req: Request): Promise<Response> {
  const adminKey = process.env.MAIN_APP_ADMIN_API_KEY;
  if (!adminKey) return Response.json({ error: "server_misconfigured" }, { status: 500 });

  // Constant-time compare: a plain `!==` on the bearer secret leaks the key
  // byte-by-byte via response timing (D-091, #397).
  const auth = req.headers.get("authorization") ?? "";
  if (!constantTimeEqual(auth, `Bearer ${adminKey}`)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("platform_settings")
    .select("key, value, updated_at")
    .order("key", { ascending: true });

  if (error) {
    console.error("[admin/platform-settings] read failed:", error.message);
    return Response.json({ error: "db_error" }, { status: 500 });
  }

  const settings = (data ?? []).map((row) => {
    const updatedAt = (row as { updated_at: string }).updated_at;
    return {
      key: (row as { key: string }).key,
      value: (row as { value: unknown }).value,
      source_revision: Math.floor(new Date(updatedAt).getTime() / 1000),
      updated_at: updatedAt,
    };
  });

  return Response.json({ settings });
}
