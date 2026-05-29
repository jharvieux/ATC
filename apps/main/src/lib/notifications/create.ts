// §23.8 — In-app notification creation helper.
// Called from Inngest event handlers and API routes to insert notification rows.
// Caller must pass a service-role SupabaseClient.

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwaitRequired } from "@/lib/db/safe-mutation";

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
}

// Throws SupabaseMutationError on a failed insert rather than returning null:
// the prior signature couldn't distinguish "insert failed" from "no row", so
// a dropped notification was silently lost (D-091, #400). The sole caller is
// an Inngest handler where a throw correctly triggers a retry.
export async function createNotification(input: CreateNotificationInput): Promise<{ id: string }> {
  const { db, tenant_id, user_id, category, title, body, link_url, icon } = input;
  return await safeAwaitRequired<{ id: string }>(
    db
      .from("notifications")
      .insert({
        tenant_id,
        user_id,
        category,
        title,
        ...(body ? { body } : {}),
        ...(link_url ? { link_url } : {}),
        ...(icon ? { icon } : {}),
      })
      .select("id")
      .single(),
    "notifications.insert",
  );
}
