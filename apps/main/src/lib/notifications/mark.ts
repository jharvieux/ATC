// §23.8 — Shared body for /api/notifications/mark-read and /dismiss, which
// were byte-identical except for the timestamp column they write (#1610).
//
// Auth stays in each route file (assertPermission), not here — the §30.8
// auth-bypass static probe checks each route.ts individually for an auth
// token, so centralizing the permission check into this helper would make
// both routes look unauthenticated to that scan.
//
// Takes a TenantContext (not a pre-built SupabaseClient) and calls
// tenantClient() itself, so the tenant-scoping is visible in this file
// rather than tripping the d091 service-role-tenant heuristic, which
// flags any `.from()` call reached through a generically-typed
// `SupabaseClient` parameter as a potential unscoped service-role query.

import type { TenantContext } from "@/lib/db/tenant-context";
import { tenantClient } from "@/lib/db/tenant-client";

export async function markNotifications(
  ctx: TenantContext,
  userId: string,
  ids: string[],
  column: "read_at" | "dismissed_at",
): Promise<{ error: { message: string } | null }> {
  const db = tenantClient(ctx);
  const now = new Date().toISOString();
  const { error } = await db
    .from("notifications")
    .update({ [column]: now })
    .in("id", ids)
    .eq("user_id", userId)
    .is(column, null);
  return { error };
}
