"use client";

// BP37 §37.7.1 — Per-record task list embed.
//
// Drop into a contact / quote / booking detail page. Lists tasks
// scoped to that record + a quick-add form. Re-fetches on add/done.

import { useCallback, useEffect, useState } from "react";

type Task = {
  id: string;
  title: string;
  description: string | null;
  task_type: string;
  status: string;
  priority: string;
  due_at: string | null;
  origin: string;
};

type ScopeKey = "contact_id" | "quote_id" | "booking_id";

export function TaskListInline(props: { scope: ScopeKey; record_id: string }): JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [title, setTitle] = useState("");
  const [taskType, setTaskType] = useState<string>("follow_up");
  const [dueAt, setDueAt] = useState("");

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    const sp = new URLSearchParams();
    sp.set(props.scope, props.record_id);
    try {
      const r = await fetch(`/api/tasks?${sp.toString()}`);
      if (!r.ok) return;
      const data = (await r.json()) as { tasks: Task[] };
      setTasks(data.tasks ?? []);
    } finally {
      setLoading(false);
    }
  }, [props.scope, props.record_id]);

  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  const submit = async () => {
    const body: Record<string, unknown> = {
      [props.scope]: props.record_id,
      title,
      task_type: taskType,
    };
    if (dueAt) body.due_at = new Date(dueAt).toISOString();
    const r = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      setTitle("");
      setDueAt("");
      setShowAdd(false);
      await fetchTasks();
    }
  };

  const complete = async (id: string) => {
    await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    await fetchTasks();
  };

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold">Tasks</h3>
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="text-xs text-blue-600 hover:underline"
        >
          {showAdd ? "× Cancel" : "+ Task"}
        </button>
      </div>
      {showAdd && (
        <div className="border border-gray-200 rounded-md p-3 mb-3 bg-gray-50">
          <input
            type="text"
            placeholder="Title…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full border border-gray-300 rounded px-2 py-1 text-sm mb-2"
          />
          <div className="flex gap-2 mb-2">
            <select
              value={taskType}
              onChange={(e) => setTaskType(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-sm"
            >
              <option value="call">Call</option>
              <option value="email">Email</option>
              <option value="text">Text</option>
              <option value="meeting">Meeting</option>
              <option value="follow_up">Follow-up</option>
              <option value="review">Review</option>
              <option value="document">Document</option>
              <option value="custom">Custom</option>
            </select>
            <input
              type="datetime-local"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-sm"
            />
            <button
              onClick={() => void submit()}
              disabled={!title.trim()}
              className="ml-auto bg-blue-600 text-white px-3 py-1 rounded text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>
      )}
      {loading ? (
        <div className="text-xs text-gray-400">Loading…</div>
      ) : tasks.length === 0 ? (
        <div className="text-xs text-gray-400">No tasks for this record.</div>
      ) : (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded-md">
          {tasks.map((t) => (
            <li key={t.id} className="px-3 py-2 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{t.title}</div>
                <div className="text-xs text-gray-500">
                  {t.task_type} · {t.due_at ? new Date(t.due_at).toLocaleDateString() : "no due"}
                  {t.origin !== "manual" && (
                    <span className="ml-2 text-amber-700">[{t.origin}]</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => void complete(t.id)}
                className="text-xs bg-green-600 text-white px-2 py-1 rounded hover:bg-green-700"
              >
                Done
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
