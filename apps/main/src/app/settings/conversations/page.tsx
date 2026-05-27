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
    <main style={{ padding: 24, maxWidth: 760, margin: "0 auto" }}>
      <h1>Conversations</h1>
      <p style={{ color: "#555" }}>
        Your chat history with our AI travel concierges.
      </p>

      {pending && (
        <div style={{ marginTop: 16 }}>
          <UndoBanner
            anonymousSessionId={pending.anonymous_session_id}
            transferSoftCommitAt={pending.transfer_soft_commit_at}
            transferCommittedAt={pending.transfer_committed_at}
          />
        </div>
      )}

      {pendingError && (
        <div
          style={{
            background: "#fef3c7",
            border: "1px solid #fde68a",
            padding: 12,
            borderRadius: 6,
            marginTop: 16,
            fontSize: 13,
          }}
        >
          Could not load transfer status: {pendingError}. If you recently signed
          in and expected to see an undo banner, please refresh.
        </div>
      )}

      {error && (
        <div style={{ background: "#fee2e2", padding: 12, borderRadius: 6, marginTop: 16 }}>
          {error}
        </div>
      )}

      {conversations === null ? (
        <p style={{ color: "#888", marginTop: 16 }}>Loading…</p>
      ) : conversations.length === 0 ? (
        <p style={{ color: "#555", marginTop: 16 }}>
          No conversations yet. Start a chat to see it here.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, marginTop: 16 }}>
          {conversations.map((conv) => (
            <li
              key={conv.id}
              style={{
                padding: 12,
                border: "1px solid #e5e7eb",
                borderRadius: 6,
                marginBottom: 8,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
              }}
            >
              <div>
                <a
                  href={`/chat?conversation=${conv.id}`}
                  style={{ color: "#1d4ed8", textDecoration: "none", fontWeight: 500 }}
                >
                  {conv.title ?? "(untitled conversation)"}
                </a>
                <p style={{ margin: "4px 0 0 0", color: "#6b7280", fontSize: 13 }}>
                  {conv.message_count} messages · status: {conv.status}
                </p>
              </div>
              <div style={{ color: "#9ca3af", fontSize: 12, whiteSpace: "nowrap" }}>
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
