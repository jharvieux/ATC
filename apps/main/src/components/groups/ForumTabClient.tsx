"use client";

// §19.7 — Coordinator forum view: all thread + message statuses visible.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const STATUS_CHIP: Record<string, string> = {
  visible: "bg-emerald-100 text-emerald-700",
  pending: "bg-gray-100 text-gray-600",
  flagged_review: "bg-amber-100 text-amber-700",
  hidden: "bg-red-100 text-red-600",
  pending_moderation: "bg-purple-100 text-purple-700",
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
  user_id: string;
  parent_message_id: string | null;
  created_at: string;
}

interface ForumInfo {
  forum_id: string;
  is_locked: boolean;
  is_coordinator: boolean;
}

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
      if (res.ok) {
        const data: { messages: Message[] } = await res.json();
        setMessages(data.messages ?? []);
      }
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
    return <p className="text-sm text-muted-foreground">Loading forum…</p>;
  }

  if (error || !forum) {
    return <p className="text-sm text-red-500">{error ?? "Forum not found"}</p>;
  }

  if (selectedThread) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setSelectedThread(null); setMessages([]); }}
            className="text-sm text-blue-600 hover:underline"
          >
            ← Threads
          </button>
          <h3 className="font-semibold text-[15px]">{selectedThread.title}</h3>
          {selectedThread.is_pinned && (
            <span className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full">Pinned</span>
          )}
          {selectedThread.is_announcement && (
            <span className="text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full">Announcement</span>
          )}
        </div>

        {messagesLoading ? (
          <p className="text-sm text-muted-foreground">Loading messages…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((msg) => (
              <li
                key={msg.id}
                className={`rounded-md border p-3 text-sm ${msg.parent_message_id ? "ml-6 border-l-2 border-l-blue-200" : ""}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-xs text-muted-foreground">{msg.user_id.slice(0, 8)}…</span>
                  <span className={`text-[11px] px-1.5 py-0.5 rounded-full font-medium ${STATUS_CHIP[msg.status] ?? "bg-gray-100 text-gray-600"}`}>
                    {msg.status}
                  </span>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {new Date(msg.created_at).toLocaleString()}
                  </span>
                </div>
                <p className="text-[14px] whitespace-pre-wrap">{msg.content}</p>
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
            <span className="text-xs bg-red-50 text-red-600 px-2 py-0.5 rounded-full font-medium">
              Forum locked
            </span>
          )}
        </div>
        {!forum.is_locked && (
          <Button variant="outline" onClick={() => setCreatingThread(true)} disabled={creatingThread}>
            + New thread
          </Button>
        )}
      </div>

      {creatingThread && (
        <div className="flex flex-col gap-2 p-3 border border-gray-200 rounded-md bg-gray-50">
          <div className="flex flex-col gap-1">
            <Label htmlFor="thread-title" className="text-xs">Thread title</Label>
            <Input
              id="thread-title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="What is this thread about?"
              className="text-sm"
              disabled={submitting}
            />
          </div>
          {createError && <p className="text-xs text-red-500">{createError}</p>}
          <div className="flex gap-2 mt-1">
            <Button onClick={createThread} disabled={submitting || !newTitle.trim()}>
              {submitting ? "Creating…" : "Create"}
            </Button>
            <Button
              variant="outline"
              onClick={() => { setCreatingThread(false); setNewTitle(""); setCreateError(null); }}
              disabled={submitting}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {threads.length === 0 ? (
        <p className="text-sm text-muted-foreground">No threads yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {threads.map((thread) => (
            <li key={thread.id}>
              <button
                onClick={() => openThread(thread)}
                className="w-full text-left px-3 py-3 hover:bg-muted/40 flex items-center gap-2"
              >
                <span className="flex-1 text-[14px] font-medium">{thread.title}</span>
                {thread.is_pinned && (
                  <span className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded">Pinned</span>
                )}
                {thread.is_announcement && (
                  <span className="text-xs bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded">Announcement</span>
                )}
                {thread.is_locked && (
                  <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">Locked</span>
                )}
                <span className="text-xs text-muted-foreground">
                  {new Date(thread.created_at).toLocaleDateString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
