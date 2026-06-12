// §11.6 — Deferred-processing guarantee during the 24-hour soft-commit window.
//
// All derived-data producers (memory extraction, CRM contact creation, pre-cruise
// email scheduling) MUST call assertNotInDeferredWindow before doing any work on
// a conversation that was transferred from an anonymous session.
//
// If the guard throws, the caller returns early without modifying any data.
// This is what makes undo simple: no derived data exists yet during the 24h window
// because every producer gates on this guard.

import type { SupabaseClient } from "@supabase/supabase-js";

export class DeferredProcessingError extends Error {
  constructor(public readonly anonymous_session_id: string) {
    super(
      `DeferredProcessingError: conversation is within the 24-hour anonymous→auth ` +
        `transfer soft-commit window (anonymous_session_id=${anonymous_session_id}). ` +
        `Defer all derived-data processing until transfer_committed_at is set.`,
    );
    this.name = "DeferredProcessingError";
  }
}

/**
 * Throws DeferredProcessingError if the conversation belongs to an anonymous
 * session that is in the 24-hour soft-commit window (soft_commit_at set,
 * committed_at not yet set).
 *
 * @param db - A Supabase client scoped to the correct tenant (tenantClient or service-role).
 * @param conversation_id - The conversation to check.
 * @param tenant_id - The tenant owning the conversation (two-layer isolation).
 */
export async function assertNotInDeferredWindow(
  db: SupabaseClient,
  conversation_id: string,
  tenant_id: string,
): Promise<void> {
  // Find any anonymous_session linked to this conversation that is mid-commit.
  // The join goes: conversations.anonymous_session_id → anonymous_sessions.id
  // Conversations may not have an anonymous_session_id column yet (that wire
  // happens when auth is fully built out). We guard gracefully — if the column
  // doesn't exist in the query result, assume not deferred.
  const { data: conv, error: convErr } = await db
    .from("conversations")
    .select("anonymous_session_id")
    .eq("id", conversation_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (convErr) throw new Error(`deferred_window_lookup_failed: conversations.read: ${convErr.message}`);

  const anonSessionId = conv?.anonymous_session_id as string | null | undefined;
  if (!anonSessionId) return;

  const { data: session, error: sessionErr } = await db
    .from("anonymous_sessions")
    .select("id, transfer_soft_commit_at, transfer_committed_at")
    .eq("id", anonSessionId)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (sessionErr) throw new Error(`deferred_window_lookup_failed: anonymous_sessions.read: ${sessionErr.message}`);

  if (!session) return;

  if (session.transfer_soft_commit_at && !session.transfer_committed_at) {
    throw new DeferredProcessingError(anonSessionId);
  }
}
