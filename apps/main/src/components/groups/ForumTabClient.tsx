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

interface ForumState {
  forum: ForumInfo | null;
  threads: Thread[];
  selectedThread: Thread | null;
  messages: Message[];
  loading: boolean;
  error: string | null;
  messagesLoading: boolean;
}

interface ComposeState {
  creatingThread: boolean;
  newTitle: string;
  createError: string | null;
  submitting: boolean;
}

export function ForumTabClient({ groupId }: { groupId: string }) {
  // #1812 — the 11 useState hooks (forum/thread/message data vs. the
  // new-thread compose form) are grouped into 2 state objects by concern,
  // one useState each, matching the pattern established in #1791.
  const [state, setState] = useState<ForumState>({
    forum: null, threads: [], selectedThread: null, messages: [], loading: true, error: null, messagesLoading: false,
  });
  const [compose, setCompose] = useState<ComposeState>({
    creatingThread: false, newTitle: "", createError: null, submitting: false,
  });

  const loadForum = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const fRes = await fetch(`/api/groups/${groupId}/forum`);
      if (!fRes.ok) {
        setState((s) => ({ ...s, error: `Failed to load forum (${fRes.status})` }));
        return;
      }
      const fData: ForumInfo = await fRes.json();

      const tRes = await fetch(`/api/forums/${fData.forum_id}/threads`);
      if (!tRes.ok) {
        setState((s) => ({ ...s, forum: fData, error: `Failed to load threads (${tRes.status})` }));
        return;
      }
      const tData: { threads: Thread[] } = await tRes.json();
      setState((s) => ({ ...s, forum: fData, threads: tData.threads ?? [] }));
    } catch (err) {
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : "Failed to load" }));
    } finally {
      setState((s) => ({ ...s, loading: false }));
    }
  }, [groupId]);

  useEffect(() => { void loadForum(); }, [loadForum]);

  async function openThread(thread: Thread) {
    if (!state.forum) return;
    setState((s) => ({ ...s, selectedThread: thread, messagesLoading: true }));
    try {
      const res = await fetch(
        `/api/forums/${state.forum.forum_id}/threads/${thread.id}/messages`,
      );
      const data: { messages: Message[]; error?: string } = await res.json();
      if (!res.ok) {
        setState((s) => ({ ...s, error: data.error ?? `Failed to load messages (${res.status})` }));
        return;
      }
      setState((s) => ({ ...s, messages: data.messages ?? [] }));
    } catch (err) {
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : "Failed to load messages" }));
    } finally {
      setState((s) => ({ ...s, messagesLoading: false }));
    }
  }

  async function createThread() {
    if (!state.forum || !compose.newTitle.trim()) return;
    setCompose((c) => ({ ...c, createError: null, submitting: true }));
    try {
      const res = await fetch(`/api/forums/${state.forum.forum_id}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: compose.newTitle.trim() }),
      });
      const data: { error?: string } = await res.json();
      if (!res.ok) {
        setCompose((c) => ({ ...c, createError: data.error ?? `Error ${res.status}` }));
        return;
      }
      setCompose((c) => ({ ...c, newTitle: "", creatingThread: false }));
      await loadForum();
    } catch (err) {
      setCompose((c) => ({ ...c, createError: err instanceof Error ? err.message : "Failed to create" }));
    } finally {
      setCompose((c) => ({ ...c, submitting: false }));
    }
  }

  if (state.loading) {
    return <p className="text-sm font-medium text-[var(--cruise-text-muted)]">Loading forum…</p>;
  }

  if (state.error || !state.forum) {
    return <p className="text-sm text-[var(--cruise-coral)]">{state.error ?? "Forum not found"}</p>;
  }

  const { forum, threads, selectedThread, messages, messagesLoading } = state;
  const { creatingThread, newTitle, createError, submitting } = compose;

  if (selectedThread) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setState((s) => ({ ...s, selectedThread: null, messages: [] }))}
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
          <button type="button" className={BUTTON_OUTLINE} onClick={() => setCompose((c) => ({ ...c, creatingThread: true }))} disabled={creatingThread}>
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
              onChange={(e) => setCompose((c) => ({ ...c, newTitle: e.target.value }))}
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
              onClick={() => setCompose((c) => ({ ...c, creatingThread: false, newTitle: "", createError: null }))}
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
