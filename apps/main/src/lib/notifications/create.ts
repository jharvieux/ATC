// §23.8 — In-app notification creation helper.
// Called from Inngest event handlers and API routes to insert notification rows.
// Caller must pass a service-role SupabaseClient.

import type { SupabaseClient } from "@supabase/supabase-js";

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

export async function createNotification(input: CreateNotificationInput): Promise<{ id: string } | null> {
  const { db, tenant_id, user_id, category, title, body, link_url, icon } = input;
  const { data } = await db
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
    .single();
  return (data as { id: string } | null);
}
