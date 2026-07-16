// §23.8 — In-app notification creation helper.
// Called from Inngest event handlers and API routes to insert notification rows.
// Caller must pass a service-role SupabaseClient.

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwaitRequired, unwrapRequired, SupabaseMutationError } from "@/lib/db/safe-mutation";

export type NotificationCategory =
  | "booking_update"
  | "commission_settled"
  | "group_activity"
  | "escalation"
  | "system";

export interface CreateNotificationInput {
  db: SupabaseClient;
  tenant_id: string;
  user_id: string;
  category: NotificationCategory;
  title: string;
  body?: string;
  link_url?: string;
  icon?: string;
  // Opt-in idempotency key (#1954). When set, a partial UNIQUE index
  // (notifications_dedup_key_uidx) makes the insert idempotent: a retry that
  // re-inserts the same key is a no-op that returns the existing row's id
  // instead of writing a duplicate. Callers that fan out one notification per
  // recipient across an operation that Inngest may retry must set a
  // deterministic key (e.g. `ccpa_purge:<purged_user_id>:<recipient_user_id>`).
  dedup_key?: string;
}

// Throws SupabaseMutationError on a failed insert rather than returning null:
// the prior signature couldn't distinguish "insert failed" from "no row", so
// a dropped notification was silently lost (D-091, #400). The sole caller is
// an Inngest handler where a throw correctly triggers a retry.
export async function createNotification(input: CreateNotificationInput): Promise<{ id: string }> {
  const { db, tenant_id, user_id, category, title, body, link_url, icon, dedup_key } = input;
  const row = {
    tenant_id,
    user_id,
    category,
    title,
    ...(body ? { body } : {}),
    ...(link_url ? { link_url } : {}),
    ...(icon ? { icon } : {}),
    ...(dedup_key ? { dedup_key } : {}),
  };

  if (!dedup_key) {
    return await safeAwaitRequired<{ id: string }>(
      db.from("notifications").insert(row).select("id").single(),
      "notifications.insert",
    );
  }

  // Idempotent path (#1954): insert, and on a unique-violation (23505) treat it
  // as an already-delivered no-op — return the pre-existing row's id so a retry
  // produces exactly one row per dedup_key, never a duplicate.
  const result = await db.from("notifications").insert(row).select("id").single();
  if (result.error) {
    if (result.error.code === "23505") {
      return await safeAwaitRequired<{ id: string }>(
        db
          .from("notifications")
          .select("id")
          .eq("tenant_id", tenant_id)
          .eq("dedup_key", dedup_key)
          .single(),
        "notifications.dedup_lookup",
      );
    }
    throw new SupabaseMutationError("notifications.insert", result.error);
  }
  return unwrapRequired(result, "notifications.insert");
}
