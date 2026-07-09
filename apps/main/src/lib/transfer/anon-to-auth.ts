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
// undoTransfer: reverses the transfer within the 24-hour window.
//   - CAS-clears the soft-commit state (loses to a finalize that already
//     committed → 409), then reverts conversation re-keying.
//   - Cancels the pending finalize event via a no-op flag on re-read.

import type { SupabaseClient } from "@supabase/supabase-js";
import { inngest } from "@/inngest/client";
import { writeAuditLog } from "@/lib/audit/write";
import { safeAwaitRowCount, SupabaseMutationError } from "@/lib/db/safe-mutation";

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
  //
  //    transfer_soft_commit_at is the per-attempt marker: the finalize
  //    function's idempotency key combines it with anonymous_session_id so two
  //    concurrent runs of the SAME soft-commit attempt collapse to one (no
  //    double memory-emit / double contact-bind, #1655), while a legitimate
  //    undo→re-commit produces a NEW timestamp → new key → still finalizes.
  await inngest.send({
    name: "anonymous_session.transfer_finalize",
    data: {
      tenant_id,
      anonymous_session_id,
      user_id,
      transfer_soft_commit_at: now.toISOString(),
    },
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
 * Reverts conversation re-keying and cancels the pending finalization by
 * relying on the finalize function's re-check of transfer_committed_at.
 *
 * Returns 409 payload if the transfer was already finalized — including the
 * race where finalize commits between our pre-check and the CAS clear.
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
    .eq("tenant_id", tenant_id)
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

  // 2. CAS-clear the soft-commit state and increment undo count. The pre-check
  //    above is a fast 409, but finalize can commit between that read and this
  //    write. Guarding on transfer_committed_at IS NULL (and soft_commit still
  //    set) makes the clear lose that race cleanly: zero rows → finalize won →
  //    409, rather than blindly reverting a committed transfer.
  try {
    await safeAwaitRowCount(
      db
        .from("anonymous_sessions")
        .update({
          transfer_soft_commit_at: null,
          transferred_to_user_id: null,
          transfer_undo_count: (session.transfer_undo_count ?? 0) + 1,
        })
        .eq("id", anonymous_session_id)
        .eq("tenant_id", tenant_id)
        .eq("transferred_to_user_id", user_id)
        .is("transfer_committed_at", null)
        .not("transfer_soft_commit_at", "is", null)
        .select("id"),
      "anonymous_sessions.undo_transfer",
      1,
    );
  } catch (casErr) {
    if (casErr instanceof SupabaseMutationError && casErr.code === "ROW_COUNT_MISMATCH") {
      return { error: "transfer_already_finalized", status: 409 };
    }
    throw casErr;
  }

  // 3. Revert conversations back to null user_id (anonymous). Messages carry no
  //    user_id — ownership follows the conversation, so this is the only revert
  //    needed. The finalize event no-ops when it fires because
  //    transfer_soft_commit_at is now NULL.
  const { error: convErr } = await db
    .from("conversations")
    .update({ user_id: null })
    .eq("anonymous_session_id", anonymous_session_id)
    .eq("tenant_id", tenant_id);

  if (convErr) {
    throw new Error(`undoTransfer: conversation revert failed — ${convErr.message}`);
  }

  // 4. Audit-log snapshot per §11.6 — message count + time range. Messages are
  //    reached via their conversations (no direct anonymous_session_id column).
  const { data: convRows, error: convSnapErr } = await db
    .from("conversations")
    .select("id")
    .eq("anonymous_session_id", anonymous_session_id)
    .eq("tenant_id", tenant_id);

  if (convSnapErr) {
    throw new Error(`undoTransfer: conversation snapshot failed — ${convSnapErr.message}`);
  }

  const convIds = (convRows ?? []).map((c: { id: string }) => c.id);
  let msgSnapshot: { created_at: string }[] = [];
  if (convIds.length > 0) {
    const { data: msgRows, error: msgSnapErr } = await db
      .from("messages")
      .select("created_at")
      .in("conversation_id", convIds)
      .eq("tenant_id", tenant_id)
      .order("created_at", { ascending: true });
    if (msgSnapErr) {
      throw new Error(`undoTransfer: message snapshot failed — ${msgSnapErr.message}`);
    }
    msgSnapshot = (msgRows ?? []) as { created_at: string }[];
  }

  const messageCount = msgSnapshot.length;
  const timeRange = msgSnapshot.length > 0
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
