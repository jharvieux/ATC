"use client";

// §11.6 — Customer conversations page. Two surfaces:
//   1. UndoBanner — visible only when the customer has a pending (soft-
//      committed, not yet finalized) anonymous→authenticated session
//      transfer. Banner copy + countdown live in the component itself.
//   2. Conversation list — chronological list of the customer's
//      conversations across all tenants the customer has chatted with.
//
// The conversation list reuses /api/chat/conversations. The Undo state
// comes from /api/user/pending-transfer.

import { useEffect, useState } from "react";
import { UndoBanner } from "@/components/transfer/UndoBanner";

type Pending = {
  anonymous_session_id: string;
  transfer_soft_commit_at: string;
  transfer_committed_at: string | null;
};

type ConversationSummary = {
  id: string;
  title: string | null;
  status: string;
  last_message_at: string | null;
  message_count: number;
};

export default function ConversationsPage(): JSX.Element {
  const [pending, setPending] = useState<Pending | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([loadPending(), loadConversations()]);
  }, []);

  async function loadPending(): Promise<void> {
    try {
      const res = await fetch("/api/user/pending-transfer");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { pending: Pending | null };
      setPending(body.pending);
      setPendingError(null);
    } catch (err) {
      // Surface the error — the banner could be the only path the customer
      // has to undo a transfer before the 24h window closes. Silent swallow
      // would hide it indefinitely if (e.g.) the permission grant regressed.
      setPendingError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadConversations(): Promise<void> {
    try {
      const res = await fetch("/api/chat/conversations");
      if (!res.ok) throw new Error(`conversations load failed: ${res.status}`);
      const body = (await res.json()) as { conversations?: ConversationSummary[] };
      setConversations(body.conversations ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setConversations([]);
    }
  }

  return (
    <main className="p-6 max-w-[760px] mx-auto">
      <h1>Conversations</h1>
      <p className="text-muted-foreground">
        Your chat history with our AI travel concierges.
      </p>

      {pending && (
        <div className="mt-4">
          <UndoBanner
            anonymousSessionId={pending.anonymous_session_id}
            transferSoftCommitAt={pending.transfer_soft_commit_at}
            transferCommittedAt={pending.transfer_committed_at}
          />
        </div>
      )}

      {pendingError && (
        <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 p-3 rounded-md mt-4 text-[13px] text-amber-900 dark:text-amber-200">
          Could not load transfer status: {pendingError}. If you recently signed
          in and expected to see an undo banner, please refresh.
        </div>
      )}

      {error && (
        <div className="bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300 p-3 rounded-md mt-4">
          {error}
        </div>
      )}

      {conversations === null ? (
        <p className="text-muted-foreground mt-4">Loading…</p>
      ) : conversations.length === 0 ? (
        <p className="text-muted-foreground mt-4">
          No conversations yet. Start a chat to see it here.
        </p>
      ) : (
        <ul className="list-none p-0 mt-4 space-y-2">
          {conversations.map((conv) => (
            <li
              key={conv.id}
              className="p-3 border border-border rounded-md flex justify-between items-center gap-3"
            >
              <div>
                <a
                  href={`/chat?conversation=${conv.id}`}
                  className="text-primary no-underline font-medium hover:underline"
                >
                  {conv.title ?? "(untitled conversation)"}
                </a>
                <p className="mt-1 mb-0 text-muted-foreground text-[13px]">
                  {conv.message_count} messages · status: {conv.status}
                </p>
              </div>
              <div className="text-muted-foreground text-[12px] whitespace-nowrap">
                {conv.last_message_at
                  ? new Date(conv.last_message_at).toLocaleString()
                  : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
