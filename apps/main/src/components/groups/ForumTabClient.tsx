"use client";

// §19.7 — Coordinator forum view: all thread + message statuses visible.
//
// Restyled to the group-landing "Bright & Vacation-y" cruise identity
// (specs/design_handoff_group_landing/). The author-name span shows the
// server-computed author_name for guest/invitation_id-authored messages
// (roster-style display name, anonymity-aware) and falls back to the raw
// user_id prefix for staff-authored ones — same visual treatment either way.

import { useCallback, useEffect, useState } from "react";
import { formatDate } from "@/lib/format-date";

const STATUS_CHIP: Record<string, string> = {
  visible: "border-[var(--cruise-success)] text-[var(--cruise-success)]",
  pending: "border-[var(--cruise-border)] text-[var(--cruise-text-muted)]",
  flagged_review: "border-[#e8a017] text-[#e8a017]",
  hidden: "border-[var(--cruise-coral)] text-[var(--cruise-coral)]",
  pending_moderation: "border-[var(--cruise-accent)] text-[var(--cruise-accent)]",
};

interface Thread {
  id: string;
  title: string;
  is_locked: boolean;
  is_pinned: boolean;
  is_announcement: boolean;
  created_at: string;
}

interface Message {
  id: string;
  content: string;
  status: string;
  user_id: string | null;
  // Guest-authored messages (anonymous invitee forum access) carry
  // invitation_id instead of user_id — forum_messages_author_xor.
  // author_name is server-computed for those (roster-style display name /
  // "Anonymous"); null for user-authored messages, which keep today's raw id.
  invitation_id: string | null;
  author_name: string | null;
  parent_message_id: string | null;
  created_at: string;
}

interface ForumInfo {
  forum_id: string;
  is_locked: boolean;
  is_coordinator: boolean;
}

const CARD = "rounded-[var(--cruise-radius-card)] bg-[var(--cruise-surface)] p-6 shadow-[var(--cruise-card-shadow)]";
const INPUT =
  "w-full rounded-[var(--cruise-radius-itinerary)] border border-[var(--cruise-border)] bg-[var(--cruise-bg)] px-3 py-2 text-sm text-[var(--cruise-text)] placeholder:text-[var(--cruise-text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cruise-accent)]";
const BUTTON_PRIMARY =
  "rounded-[var(--cruise-radius-pill)] bg-[var(--cruise-accent)] px-4 py-2 font-[family-name:var(--font-quicksand)] text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60";
const BUTTON_OUTLINE =
  "rounded-[var(--cruise-radius-pill)] border border-[var(--cruise-border)] bg-transparent px-4 py-2 font-[family-name:var(--font-quicksand)] text-sm font-bold text-[var(--cruise-text)] transition-colors hover:bg-[var(--cruise-bg)] disabled:opacity-60";
const BADGE = "rounded-[var(--cruise-radius-pill)] px-2 py-0.5 text-xs font-medium";

export function ForumTabClient({ groupId }: { groupId: string }) {
  const [forum, setForum] = useState<ForumInfo | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);

  const [creatingThread, setCreatingThread] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadForum = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fRes = await fetch(`/api/groups/${groupId}/forum`);
      if (!fRes.ok) {
        setError(`Failed to load forum (${fRes.status})`);
        return;
      }
      const fData: ForumInfo = await fRes.json();
      setForum(fData);

      const tRes = await fetch(`/api/forums/${fData.forum_id}/threads`);
      if (!tRes.ok) {
        setError(`Failed to load threads (${tRes.status})`);
        return;
      }
      const tData: { threads: Thread[] } = await tRes.json();
      setThreads(tData.threads ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => { void loadForum(); }, [loadForum]);

  async function openThread(thread: Thread) {
    if (!forum) return;
    setSelectedThread(thread);
    setMessagesLoading(true);
    try {
      const res = await fetch(
        `/api/forums/${forum.forum_id}/threads/${thread.id}/messages`,
      );
      const data: { messages: Message[]; error?: string } = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Failed to load messages (${res.status})`);
        return;
      }
      setMessages(data.messages ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load messages");
    } finally {
      setMessagesLoading(false);
    }
  }

  async function createThread() {
    if (!forum || !newTitle.trim()) return;
    setCreateError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/forums/${forum.forum_id}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: newTitle.trim() }),
      });
      const data: { error?: string } = await res.json();
      if (!res.ok) {
        setCreateError(data.error ?? `Error ${res.status}`);
        return;
      }
      setNewTitle("");
      setCreatingThread(false);
      await loadForum();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <p className="text-sm font-medium text-[var(--cruise-text-muted)]">Loading forum…</p>;
  }

  if (error || !forum) {
    return <p className="text-sm text-[var(--cruise-coral)]">{error ?? "Forum not found"}</p>;
  }

  if (selectedThread) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => { setSelectedThread(null); setMessages([]); }}
            className="text-sm font-semibold text-[var(--cruise-accent)] hover:underline"
          >
            ← Threads
          </button>
          <h3 className="font-[family-name:var(--font-quicksand)] text-[15px] font-bold text-[var(--cruise-text)]">{selectedThread.title}</h3>
          {selectedThread.is_pinned && (
            <span className={`${BADGE} bg-[var(--cruise-bg)] text-[var(--cruise-accent)]`}>Pinned</span>
          )}
          {selectedThread.is_announcement && (
            <span className={`${BADGE} bg-[var(--cruise-bg)] text-[#e8a017]`}>Announcement</span>
          )}
        </div>

        {messagesLoading ? (
          <p className="text-sm font-medium text-[var(--cruise-text-muted)]">Loading messages…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm font-medium text-[var(--cruise-text-muted)]">No messages yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((msg) => (
              <li
                key={msg.id}
                className={`${CARD} text-sm ${msg.parent_message_id ? "ml-6 border-l-2 border-l-[var(--cruise-accent)]" : ""}`}
              >
                <div className="mb-1 flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    {msg.invitation_id ? msg.author_name : `${msg.user_id?.slice(0, 8)}…`}
                  </span>
                  <span className={`${BADGE} border ${STATUS_CHIP[msg.status] ?? "border-[var(--cruise-border)] text-[var(--cruise-text-muted)]"}`}>
                    {msg.status}
                  </span>
                  <span className="ml-auto text-xs text-[var(--cruise-text-muted)]">
                    {new Date(msg.created_at).toLocaleString()}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-[14px] text-[var(--cruise-text)]">{msg.content}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {forum.is_locked && (
            <span className={`${BADGE} bg-[var(--cruise-bg)] text-[var(--cruise-coral)]`}>
              Forum locked
            </span>
          )}
        </div>
        {!forum.is_locked && (
          <button type="button" className={BUTTON_OUTLINE} onClick={() => setCreatingThread(true)} disabled={creatingThread}>
            + New thread
          </button>
        )}
      </div>

      {creatingThread && (
        <div className={`${CARD} flex flex-col gap-2`}>
          <div className="flex flex-col gap-1">
            <label htmlFor="thread-title" className="text-xs font-semibold text-[var(--cruise-text)]">Thread title</label>
            <input
              id="thread-title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="What is this thread about?"
              disabled={submitting}
              className={INPUT}
            />
          </div>
          {createError && <p className="text-xs text-[var(--cruise-coral)]">{createError}</p>}
          <div className="mt-1 flex gap-2">
            <button type="button" className={BUTTON_PRIMARY} onClick={createThread} disabled={submitting || !newTitle.trim()}>
              {submitting ? "Creating…" : "Create"}
            </button>
            <button
              type="button"
              className={BUTTON_OUTLINE}
              onClick={() => { setCreatingThread(false); setNewTitle(""); setCreateError(null); }}
              disabled={submitting}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {threads.length === 0 ? (
        <p className="text-sm font-medium text-[var(--cruise-text-muted)]">No threads yet.</p>
      ) : (
        <ul className={`${CARD} flex flex-col divide-y divide-[var(--cruise-border)] p-0`}>
          {threads.map((thread) => (
            <li key={thread.id}>
              <button
                type="button"
                onClick={() => openThread(thread)}
                className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-[var(--cruise-bg)]"
              >
                <span className="flex-1 text-[14px] font-medium text-[var(--cruise-text)]">{thread.title}</span>
                {thread.is_pinned && (
                  <span className={`${BADGE} bg-[var(--cruise-bg)] text-[var(--cruise-accent)]`}>Pinned</span>
                )}
                {thread.is_announcement && (
                  <span className={`${BADGE} bg-[var(--cruise-bg)] text-[#e8a017]`}>Announcement</span>
                )}
                {thread.is_locked && (
                  <span className={`${BADGE} bg-[var(--cruise-bg)] text-[var(--cruise-text-muted)]`}>Locked</span>
                )}
                <span className="text-xs text-[var(--cruise-text-muted)]">
                  {formatDate(thread.created_at)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
