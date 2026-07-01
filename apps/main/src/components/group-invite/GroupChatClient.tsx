"use client";

// §19.x — Anonymous invitee chat: thread list + selected-thread messages +
// compose box. Thin utility UI (no moderation controls — those are
// coordinator-only and this page has no is_coordinator concept at all; the
// API routes enforce every access rule server-side).

import { useState, type ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
}: {
  token: string;
  initialForum: { forum_id: string; is_locked: boolean; threads: ForumThread[] };
}): ReactElement {
  const [threads, setThreads] = useState(initialForum.threads);
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

  if (selectedThread) {
    return (
      <div className="flex flex-col gap-4">
        <button
          onClick={() => { setSelectedThread(null); setMessages([]); setError(null); }}
          className="text-sm text-left text-[var(--cruise-accent)] hover:underline w-fit"
        >
          ← Threads
        </button>
        <h2 className="text-[16px] font-semibold">{selectedThread.title}</h2>

        {error && <p className="text-sm text-red-500">{error}</p>}

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

        {!initialForum.is_locked && !selectedThread.is_locked && (
          <div className="flex gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Say something…"
              disabled={posting}
              className="text-sm"
            />
            <Button onClick={() => void postMessage()} disabled={posting || !draft.trim()}>
              {posting ? "Sending…" : "Send"}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="text-sm text-red-500">{error}</p>}

      {initialForum.is_locked ? (
        <p className="text-sm text-[var(--cruise-text-muted)]">This chat is currently locked.</p>
      ) : (
        <div className="flex justify-end">
          <Button variant="outline" onClick={() => setCreatingThread((v) => !v)}>
            + New thread
          </Button>
        </div>
      )}

      {creatingThread && (
        <div className="flex gap-2">
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="What is this thread about?"
            className="text-sm"
          />
          <Button onClick={() => void createThread()} disabled={!newTitle.trim()}>
            Create
          </Button>
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
    </div>
  );
}
