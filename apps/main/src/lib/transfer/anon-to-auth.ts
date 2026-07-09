// §11.6 — Anonymous→authenticated session transfer.
//
// Ownership is carried by conversations.user_id; messages have no user_id
// or anonymous_session_id column (see 20260521150000_conversations_messages.sql)
// — they belong to a user transitively through their conversation. So the
// transfer re-keys conversations only; messages follow automatically.
//
// softCommitTransfer: starts the 24-hour reversible window.
//   - Re-keys conversations to the authenticated user_id.
//   - Schedules the finalize Inngest event with a 24h delay.
//   - Undo is safe during the window: no derived data has been produced yet
//     (every derived-data producer gates on assertNotInDeferredWindow).
//
// Undo (#1647): the single implementation lives in the wired route,
// app/api/auth/transfer-session/undo/route.ts — it CAS-clears the soft-commit
// state and reverts the conversation re-keying. A prior divergent undoTransfer()
// here was never wired to a route (test-only dead code) and was removed.

import type { SupabaseClient } from "@supabase/supabase-js";
import { inngest } from "@/inngest/client";
import { writeAuditLog } from "@/lib/audit/write";

const TRANSFER_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SoftCommitResult {
  status: "soft_committed";
  expires_at: string;
}

/**
 * Starts the 24-hour soft-commit window for an anonymous→auth transfer.
 * Re-keys all conversations belonging to the anonymous session to the
 * authenticated user_id, then schedules finalization.
 *
 * @param db - tenantClient(ctx) — must be scoped to the correct tenant.
 */
export async function softCommitTransfer({
  db,
  anonymous_session_id,
  user_id,
  tenant_id,
}: {
  db: SupabaseClient;
  anonymous_session_id: string;
  user_id: string;
  tenant_id: string;
}): Promise<SoftCommitResult> {
  const now = new Date();
  const expires_at = new Date(now.getTime() + TRANSFER_WINDOW_MS).toISOString();

  // 1. Mark the anonymous session as soft-committed.
  const { error: sessionErr } = await db
    .from("anonymous_sessions")
    .update({
      transfer_soft_commit_at: now.toISOString(),
      transferred_to_user_id: user_id,
    })
    .eq("id", anonymous_session_id)
    .eq("tenant_id", tenant_id);

  if (sessionErr) {
    throw new Error(`softCommitTransfer: session update failed — ${sessionErr.message}`);
  }

  // 2. Re-key all conversations for this anonymous session to the authenticated user.
  //    The anonymous_session_id FK is retained so undo can find them.
  const { error: convErr } = await db
    .from("conversations")
    .update({ user_id })
    .eq("anonymous_session_id", anonymous_session_id)
    .eq("tenant_id", tenant_id);

  if (convErr) {
    throw new Error(`softCommitTransfer: conversation re-key failed — ${convErr.message}`);
  }

  // Messages carry no user_id — ownership follows the conversation, so
  // re-keying conversations (step 2) is sufficient.

  // 3. Emit the finalize event with a 24-hour delay via Inngest.
  //    The finalize function re-checks transfer_committed_at on arrival —
  //    if the transfer was undone by then, it no-ops.
  await inngest.send({
    name: "anonymous_session.transfer_finalize",
    data: { tenant_id, anonymous_session_id, user_id },
    ts: now.getTime() + TRANSFER_WINDOW_MS,
  });

  await writeAuditLog({
    tenant_id,
    actor_user_id: user_id,
    actor_type: "user",
    action: "session_transfer.soft_committed",
    resource_type: "anonymous_session",
    resource_id: anonymous_session_id,
    changes: { expires_at, soft_committed_at: now.toISOString() },
  });

  return { status: "soft_committed", expires_at };
}
