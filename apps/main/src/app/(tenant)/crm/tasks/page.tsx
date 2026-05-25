"use client";

// BP37 §37.7.1 — "My Tasks" dashboard grouped by due window.
// Default scope: tasks assigned to me + open/in_progress/snoozed.

import { useCallback, useEffect, useState } from "react";

type Task = {
  id: string;
  title: string;
  description: string | null;
  task_type: string;
  status: "open" | "in_progress" | "completed" | "snoozed" | "cancelled";
  priority: "low" | "normal" | "high" | "urgent";
  due_at: string | null;
  contact_id: string | null;
  quote_id: string | null;
  booking_id: string | null;
};

type Bucket = "overdue" | "today" | "this_week" | "later" | "no_due";

function bucketFor(t: Task): Bucket {
  if (!t.due_at) return "no_due";
  const ms = Date.parse(t.due_at);
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = startOfToday.getTime() + 24 * 60 * 60 * 1000;
  const endOfWeek = startOfToday.getTime() + 7 * 24 * 60 * 60 * 1000;
  if (ms < now) return "overdue";
  if (ms < endOfToday) return "today";
  if (ms < endOfWeek) return "this_week";
  return "later";
}

const BUCKET_LABELS: Record<Bucket, string> = {
  overdue: "Overdue",
  today: "Today",
  this_week: "This week",
  later: "Later",
  no_due: "No due date",
};

const PRIORITY_DOT: Record<Task["priority"], string> = {
  low: "#9ca3af",
  normal: "#3b82f6",
  high: "#f59e0b",
  urgent: "#ef4444",
};

export default function MyTasksPage(): JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [assignedToMe, setAssignedToMe] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    const sp = new URLSearchParams();
    if (assignedToMe) sp.set("assigned_to_me", "true");
    try {
      const r = await fetch(`/api/tasks?${sp.toString()}`);
      if (!r.ok) return;
      const data = (await r.json()) as { tasks: Task[] };
      setTasks(data.tasks ?? []);
    } finally {
      setLoading(false);
    }
  }, [assignedToMe]);

  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  const complete = async (id: string) => {
    setBusy(id);
    try {
      await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      });
      await fetchTasks();
    } finally {
      setBusy(null);
    }
  };

  const snooze = async (id: string, hours: number) => {
    setBusy(id);
    try {
      const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
      await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "snoozed", snoozed_until: until }),
      });
      await fetchTasks();
    } finally {
      setBusy(null);
    }
  };

  const grouped: Record<Bucket, Task[]> = {
    overdue: [],
    today: [],
    this_week: [],
    later: [],
    no_due: [],
  };
  for (const t of tasks) grouped[bucketFor(t)].push(t);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">My tasks</h1>
        <label className="text-sm flex items-center gap-2">
          <input
            type="checkbox"
            checked={assignedToMe}
            onChange={(e) => setAssignedToMe(e.target.checked)}
          />
          Assigned to me
        </label>
      </div>

      {loading && <div className="text-sm text-gray-500">Loading…</div>}
      {!loading && tasks.length === 0 && (
        <div className="text-sm text-gray-500 border border-gray-200 rounded-lg p-6 text-center">
          No open tasks. Nice work!
        </div>
      )}

      {!loading && (["overdue", "today", "this_week", "later", "no_due"] as const).map((bucket) =>
        grouped[bucket].length > 0 ? (
          <section key={bucket} className="mb-6">
            <h2 className={`text-sm font-semibold mb-2 ${bucket === "overdue" ? "text-red-700" : "text-gray-700"}`}>
              {BUCKET_LABELS[bucket]} ({grouped[bucket].length})
            </h2>
            <ul className="border border-gray-200 rounded-lg divide-y divide-gray-100">
              {grouped[bucket].map((t) => (
                <li key={t.id} className="px-4 py-3 flex items-start gap-3">
                  <span
                    title={t.priority}
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      background: PRIORITY_DOT[t.priority],
                      marginTop: 6,
                      flexShrink: 0,
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{t.title}</div>
                    {t.description && <div className="text-xs text-gray-500 mt-0.5">{t.description}</div>}
                    <div className="text-xs text-gray-400 mt-1">
                      {t.task_type} · {t.due_at ? new Date(t.due_at).toLocaleString() : "no due date"}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      disabled={busy === t.id}
                      onClick={() => void complete(t.id)}
                      className="text-xs bg-green-600 text-white px-2 py-1 rounded hover:bg-green-700 disabled:opacity-50"
                    >
                      Done
                    </button>
                    <button
                      disabled={busy === t.id}
                      onClick={() => void snooze(t.id, 24)}
                      className="text-xs bg-white border border-gray-300 text-gray-700 px-2 py-1 rounded hover:bg-gray-50 disabled:opacity-50"
                      title="Snooze 24 hours"
                    >
                      Snooze 1d
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </div>
  );
}
