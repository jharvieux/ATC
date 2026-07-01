"use client";

// §19.x — Anonymous invitee chat: thread list + selected-thread messages +
// compose box. Thin utility UI (no moderation controls — those are
// coordinator-only and this page has no is_coordinator concept at all; the
// API routes enforce every access rule server-side).
//
// Raw elements + --cruise-* tokens instead of shadcn Button/Input, same
// reasoning as the rest of the group-invite tree: those components hardcode
// the app-wide indigo/Geist theme, which would fight this page's fixed
// cruise identity. useCruiseTheme() both applies the visitor's saved
// preference from the landing page (synced via its own localStorage key) and
// sets it on this component's own wrapper div, mirroring GroupInviteView.tsx
// — this page doesn't own a toggle button, so it's a subscriber, not an owner.

import { useState, type ReactElement } from "react";
import { useCruiseTheme } from "@/lib/group-invite/use-cruise-theme";
import { quicksand } from "@/lib/fonts/quicksand";

const INPUT =
  "flex-1 rounded-[var(--cruise-radius-itinerary)] border border-[var(--cruise-border)] bg-[var(--cruise-bg)] px-3 py-2 text-sm text-[var(--cruise-text)] placeholder:text-[var(--cruise-text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cruise-accent)] disabled:opacity-60";
const BUTTON_PRIMARY =
  "rounded-[var(--cruise-radius-pill)] bg-[var(--cruise-accent)] px-4 py-2 font-[family-name:var(--font-quicksand)] text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60";
const BUTTON_OUTLINE =
  "rounded-[var(--cruise-radius-pill)] border border-[var(--cruise-border)] bg-transparent px-4 py-2 font-[family-name:var(--font-quicksand)] text-sm font-bold text-[var(--cruise-text)] transition-colors hover:bg-[var(--cruise-bg)]";

interface ForumThread {
  id: string;
  title: string;
  is_locked: boolean;
  is_pinned: boolean;
  is_announcement: boolean;
  created_at: string;
}

interface ForumMessage {
  id: string;
  content: string;
  status: string;
  created_at: string;
}

export function GroupChatClient({
  token,
  initialForum,
  error: loadError,
}: {
  token: string;
  initialForum: { forum_id: string; is_locked: boolean; threads: ForumThread[] } | null;
  error: string | null;
}): ReactElement {
  const [theme] = useCruiseTheme();
  const [threads, setThreads] = useState(initialForum?.threads ?? []);
  const [selectedThread, setSelectedThread] = useState<ForumThread | null>(null);
  const [messages, setMessages] = useState<ForumMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newTitle, setNewTitle] = useState("");
  const [creatingThread, setCreatingThread] = useState(false);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

  const base = `/api/groups/invite/${encodeURIComponent(token)}/forum`;

  async function openThread(thread: ForumThread): Promise<void> {
    setSelectedThread(thread);
    setMessagesLoading(true);
    setError(null);
    try {
      const res = await fetch(`${base}/threads/${thread.id}/messages`);
      const data = await res.json() as { messages?: ForumMessage[]; error?: string };
      if (!res.ok) {
        setError(data.error ?? `Failed to load messages (${res.status})`);
        return;
      }
      setMessages(data.messages ?? []);
    } catch {
      setError("Failed to load messages.");
    } finally {
      setMessagesLoading(false);
    }
  }

  async function createThread(): Promise<void> {
    if (!newTitle.trim()) return;
    setError(null);
    try {
      const res = await fetch(`${base}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: newTitle.trim() }),
      });
      const data = await res.json() as { error?: string; id?: string; title?: string; is_locked?: boolean; is_pinned?: boolean; is_announcement?: boolean; created_at?: string };
      if (!res.ok) {
        setError(data.error ?? `Failed to create thread (${res.status})`);
        return;
      }
      const created: ForumThread = {
        id: data.id!,
        title: data.title!,
        is_locked: data.is_locked ?? false,
        is_pinned: data.is_pinned ?? false,
        is_announcement: data.is_announcement ?? false,
        created_at: data.created_at!,
      };
      setThreads((prev) => [created, ...prev]);
      setNewTitle("");
      setCreatingThread(false);
    } catch {
      setError("Failed to create thread.");
    }
  }

  async function postMessage(): Promise<void> {
    if (!selectedThread || !draft.trim()) return;
    setPosting(true);
    setError(null);
    try {
      const res = await fetch(`${base}/threads/${selectedThread.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: draft.trim() }),
      });
      const data = await res.json() as ForumMessage & { error?: string };
      if (!res.ok) {
        setError(data.error ?? `Failed to send (${res.status})`);
        return;
      }
      setMessages((prev) => [...prev, data]);
      setDraft("");
    } catch {
      setError("Failed to send message.");
    } finally {
      setPosting(false);
    }
  }

  const shell = (inner: ReactElement): ReactElement => (
    <div data-cruise-theme={theme} className={`${quicksand.variable} min-h-screen bg-[var(--cruise-bg)] text-[var(--cruise-text)]`}>
      <div className="mx-auto max-w-[680px] px-4 py-8">
        <h1 className="mb-6 font-[family-name:var(--font-quicksand)] text-[22px] font-bold">Group Chat</h1>
        {inner}
      </div>
    </div>
  );

  if (loadError || !initialForum) {
    return shell(
      <p className="text-sm text-[var(--cruise-text-muted)]">
        {loadError === "forum_not_found" ? "This group doesn't have a chat yet." : "This chat isn't available right now."}
      </p>,
    );
  }

  if (selectedThread) {
    return shell(
      <div className="flex flex-col gap-4">
        <button
          onClick={() => { setSelectedThread(null); setMessages([]); setError(null); }}
          className="text-sm text-left text-[var(--cruise-accent)] hover:underline w-fit"
        >
          ← Threads
        </button>
        <h2 className="text-[16px] font-semibold">{selectedThread.title}</h2>

        {error && <p className="text-sm text-[var(--cruise-coral)]">{error}</p>}

        {messagesLoading ? (
          <p className="text-sm text-[var(--cruise-text-muted)]">Loading messages…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-[var(--cruise-text-muted)]">No messages yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((msg) => (
              <li key={msg.id} className="rounded-md border border-[var(--cruise-border)] bg-[var(--cruise-surface)] p-3 text-sm">
                <p className="whitespace-pre-wrap">{msg.content}</p>
                {msg.status === "pending" && (
                  <p className="text-xs text-[var(--cruise-text-muted)] mt-1">Awaiting review…</p>
                )}
              </li>
            ))}
          </ul>
        )}

        {!initialForum?.is_locked && !selectedThread.is_locked && (
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Say something…"
              disabled={posting}
              className={INPUT}
            />
            <button type="button" className={BUTTON_PRIMARY} onClick={() => void postMessage()} disabled={posting || !draft.trim()}>
              {posting ? "Sending…" : "Send"}
            </button>
          </div>
        )}
      </div>,
    );
  }

  return shell(
    <div className="flex flex-col gap-4">
      {error && <p className="text-sm text-[var(--cruise-coral)]">{error}</p>}

      {initialForum.is_locked ? (
        <p className="text-sm text-[var(--cruise-text-muted)]">This chat is currently locked.</p>
      ) : (
        <div className="flex justify-end">
          <button type="button" className={BUTTON_OUTLINE} onClick={() => setCreatingThread((v) => !v)}>
            + New thread
          </button>
        </div>
      )}

      {creatingThread && (
        <div className="flex gap-2">
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="What is this thread about?"
            className={INPUT}
          />
          <button type="button" className={BUTTON_PRIMARY} onClick={() => void createThread()} disabled={!newTitle.trim()}>
            Create
          </button>
        </div>
      )}

      {threads.length === 0 ? (
        <p className="text-sm text-[var(--cruise-text-muted)]">No threads yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--cruise-border)]">
          {threads.map((thread) => (
            <li key={thread.id}>
              <button
                onClick={() => void openThread(thread)}
                className="w-full text-left px-1 py-3 hover:opacity-80 flex items-center gap-2"
              >
                <span className="flex-1 text-[14px] font-medium">{thread.title}</span>
                {thread.is_locked && (
                  <span className="text-xs text-[var(--cruise-text-muted)]">Locked</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>,
  );
}
