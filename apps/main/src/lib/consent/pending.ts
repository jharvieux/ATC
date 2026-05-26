// §17.4 — Utility for checking a user's pending consent obligations.
//
// Used by assertPermission to gate every authenticated request other than
// the consent acceptance flow itself (per Build Prompt part-4 §17.4:
// "the global middleware redirects ANY authenticated request other than
// /consent, /logout, /legal/* to /consent if pending rows exist"). The
// codebase's auth posture has tokens in localStorage rather than cookies,
// so the gate enforces in assertPermission where we already have the
// auth_user_id — the route returns 403 with `consent_pending` and the
// client routes to /consent.

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
