// §17.4 — Utility for checking a user's pending consent obligations.
// Used by layout components and assertPermission to gate access.

import { createServiceRoleClient } from "@/lib/db/service-role-client";

export interface PendingConsent {
  document_type: string;
  document_id_pending: string;
  flagged_at: string;
}

export async function getConsentPending(authUserId: string): Promise<PendingConsent[]> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("user_consent_pending")
    .select("document_type, document_id_pending, flagged_at")
    .eq("auth_user_id", authUserId);
  if (error) throw new Error(error.message);
  return (data ?? []) as PendingConsent[];
}
