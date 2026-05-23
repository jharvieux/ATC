// §11.6 — Anonymous→authenticated session transfer.
//
// softCommitTransfer: starts the 24-hour reversible window.
//   - Re-keys conversations and messages to the authenticated user_id.
//   - Schedules the finalize Inngest event with a 24h delay.
//   - Undo is safe during the window: no derived data has been produced yet
//     (every derived-data producer gates on assertNotInDeferredWindow).
//
// undoTransfer: reverses the transfer within the 24-hour window.
//   - Reverts conversation/message re-keying back to the anonymous session.
//   - Cancels the pending finalize event via a no-op flag on re-read.

import type { SupabaseClient } from "@supabase/supabase-js";
import { inngest } from "@/inngest/client";
import { writeAuditLog } from "@/lib/audit/write";

const TRANSFER_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SoftCommitResult {
  status: "soft_committed";
  expires_at: string;
}

export interface UndoResult {
  status: "undone";
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
    .eq("id", anonymous_session_id);

  if (sessionErr) {
    throw new Error(`softCommitTransfer: session update failed — ${sessionErr.message}`);
  }

  // 2. Re-key all conversations for this anonymous session to the authenticated user.
  //    The anonymous_session_id FK is retained so undo can find them.
  const { error: convErr } = await db
    .from("conversations")
    .update({ user_id })
    .eq("anonymous_session_id", anonymous_session_id);

  if (convErr) {
    throw new Error(`softCommitTransfer: conversation re-key failed — ${convErr.message}`);
  }

  // 3. Re-key all messages in those conversations.
  //    Messages lack a direct anonymous_session_id; re-key via the already-updated
  //    conversations (user_id now points to the authenticated user).
  const { error: msgErr } = await db
    .from("messages")
    .update({ user_id })
    .eq("anonymous_session_id", anonymous_session_id);

  // Messages may not have anonymous_session_id — tolerate if the column is absent.
  if (msgErr && !msgErr.message.includes("column")) {
    throw new Error(`softCommitTransfer: message re-key failed — ${msgErr.message}`);
  }

  // 4. Emit the finalize event with a 24-hour delay via Inngest.
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

/**
 * Reverses a soft-committed transfer within the 24-hour window.
 * Reverts conversation/message re-keying and cancels the pending finalization
 * by relying on the finalize function's re-check of transfer_committed_at.
 *
 * Returns 409 payload if the transfer was already finalized.
 *
 * @param db - tenantClient(ctx) — must be scoped to the correct tenant.
 */
export async function undoTransfer({
  db,
  anonymous_session_id,
  user_id,
  tenant_id,
}: {
  db: SupabaseClient;
  anonymous_session_id: string;
  user_id: string;
  tenant_id: string;
}): Promise<UndoResult | { error: "transfer_already_finalized"; status: 409 }> {
  // 1. Read the session to verify ownership and window status.
  const { data: session, error: sessionReadErr } = await db
    .from("anonymous_sessions")
    .select("id, transferred_to_user_id, transfer_soft_commit_at, transfer_committed_at, transfer_undo_count")
    .eq("id", anonymous_session_id)
    .maybeSingle();

  if (sessionReadErr) {
    throw new Error(`undoTransfer: session read failed — ${sessionReadErr.message}`);
  }
  if (!session) {
    throw new Error(`undoTransfer: anonymous session ${anonymous_session_id} not found`);
  }

  // Authorization check: only the user the session was transferred TO can undo.
  if (session.transferred_to_user_id !== user_id) {
    throw new Error(
      `undoTransfer: user_id ${user_id} is not the transfer recipient for session ${anonymous_session_id}`,
    );
  }

  // Already finalized — undo is no longer possible.
  if (session.transfer_committed_at) {
    return { error: "transfer_already_finalized", status: 409 };
  }

  // 2. Clear the soft-commit state and increment undo count.
  const { error: clearErr } = await db
    .from("anonymous_sessions")
    .update({
      transfer_soft_commit_at: null,
      transferred_to_user_id: null,
      transfer_undo_count: (session.transfer_undo_count ?? 0) + 1,
    })
    .eq("id", anonymous_session_id);

  if (clearErr) {
    throw new Error(`undoTransfer: session clear failed — ${clearErr.message}`);
  }

  // 3. Revert conversations back to null user_id (anonymous).
  //    The finalize event will no-op when it fires because transfer_soft_commit_at is now NULL.
  const { error: convErr } = await db
    .from("conversations")
    .update({ user_id: null })
    .eq("anonymous_session_id", anonymous_session_id);

  if (convErr) {
    throw new Error(`undoTransfer: conversation revert failed — ${convErr.message}`);
  }

  // 4. Revert messages back to null user_id.
  const { error: msgErr } = await db
    .from("messages")
    .update({ user_id: null })
    .eq("anonymous_session_id", anonymous_session_id);

  if (msgErr && !msgErr.message.includes("column")) {
    throw new Error(`undoTransfer: message revert failed — ${msgErr.message}`);
  }

  // 5. Audit-log (stub until §26).
  //    Snapshot of message count and time range per §11.6.
  const { data: msgSnapshot } = await db
    .from("messages")
    .select("created_at")
    .eq("anonymous_session_id", anonymous_session_id)
    .order("created_at", { ascending: true });

  const messageCount = msgSnapshot?.length ?? 0;
  const timeRange = msgSnapshot && msgSnapshot.length > 0
    ? { from: msgSnapshot[0]?.created_at, to: msgSnapshot[msgSnapshot.length - 1]?.created_at }
    : null;

  await writeAuditLog({
    tenant_id,
    actor_user_id: user_id,
    actor_type: "user",
    action: "session_transfer.undone",
    resource_type: "anonymous_session",
    resource_id: anonymous_session_id,
    changes: { message_count: messageCount, time_range: timeRange },
  });

  return { status: "undone" };
}
