"use client";

// §11.3 / chat UX — left sidebar with three tabs:
//   • History — recent conversations (read-only list)
//   • Memory — read-only view of the caller's customer_memories row
//   • Prefs  — editable subset: rapport tone level + freeform notes
//
// All three tabs use existing APIs (/api/chat/conversations, /api/memory).
// No new server work — this is purely UI assembly.

import { useCallback, useEffect, useState } from "react";

type Tab = "history" | "memory" | "prefs";

interface Conversation {
  id: string;
  title: string | null;
  status: string | null;
  last_message_at: string | null;
  message_count: number | null;
}

interface MemoryRow {
  id?: string;
  preferences?: Record<string, unknown> | null;
  travel_history?: Record<string, unknown> | null;
  family_composition?: unknown[] | null;
  accessibility_needs?: Record<string, unknown> | null;
  dietary_restrictions?: Record<string, unknown> | null;
  loyalty_programs?: unknown[] | null;
  important_dates?: Record<string, unknown> | null;
  notes_freeform?: string | null;
  rapport_tone_level?: number | null;
  updated_at?: string;
}

export function ChatSidebar(): JSX.Element {
  const [tab, setTab] = useState<Tab>("history");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: 15 }}>Chat</h3>
      <nav style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        {(["history", "memory", "prefs"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              fontSize: 12,
              padding: "4px 6px",
              border: "1px solid #d1d5db",
              borderRadius: 4,
              background: tab === t ? "#1d4ed8" : "white",
              color: tab === t ? "white" : "#374151",
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {t}
          </button>
        ))}
      </nav>

      <div style={{ flex: 1, overflowY: "auto", fontSize: 13 }}>
        {tab === "history" && <HistoryPanel />}
        {tab === "memory" && <MemoryPanel />}
        {tab === "prefs" && <PrefsPanel />}
      </div>
    </div>
  );
}

function HistoryPanel(): JSX.Element {
  const [convos, setConvos] = useState<Conversation[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/chat/conversations?limit=20");
        if (!r.ok) {
          setErr(`HTTP ${r.status}`);
          return;
        }
        const data = (await r.json()) as { conversations?: Conversation[] };
        setConvos(data.conversations ?? []);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  if (err) return <p style={{ color: "#b91c1c" }}>Couldn&apos;t load history: {err}</p>;
  if (!convos) return <p style={{ color: "#6b7280" }}>Loading…</p>;
  if (convos.length === 0) return <p style={{ color: "#6b7280" }}>No conversations yet.</p>;

  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {convos.map((c) => (
        <li key={c.id} style={{ marginBottom: 8 }}>
          <a
            href={`/chat?id=${c.id}`}
            style={{
              display: "block",
              color: "#1d4ed8",
              textDecoration: "none",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {c.title ?? "(untitled)"}
          </a>
          <span style={{ color: "#9ca3af", fontSize: 11 }}>
            {c.message_count ?? 0} msgs ·{" "}
            {c.last_message_at ? new Date(c.last_message_at).toLocaleDateString() : "—"}
          </span>
        </li>
      ))}
    </ul>
  );
}

function MemoryPanel(): JSX.Element {
  const [mem, setMem] = useState<MemoryRow | null | "empty">("empty");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/memory");
        if (!r.ok) {
          setErr(`HTTP ${r.status}`);
          return;
        }
        const data = (await r.json()) as MemoryRow | null;
        setMem(data ?? "empty");
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  if (err) return <p style={{ color: "#b91c1c" }}>Couldn&apos;t load memory: {err}</p>;
  if (mem === "empty") return <p style={{ color: "#6b7280" }}>No memory yet — keep chatting and we&apos;ll learn.</p>;
  if (!mem) return <p style={{ color: "#6b7280" }}>Loading…</p>;

  return (
    <div>
      <Section title="Preferences" data={mem.preferences} />
      <Section title="Travel history" data={mem.travel_history} />
      <Section title="Family" data={mem.family_composition} />
      <Section title="Accessibility" data={mem.accessibility_needs} />
      <Section title="Dietary" data={mem.dietary_restrictions} />
      <Section title="Loyalty" data={mem.loyalty_programs} />
      <Section title="Important dates" data={mem.important_dates} />
      {mem.notes_freeform && (
        <div style={{ marginTop: 8 }}>
          <h4 style={{ fontSize: 12, color: "#6b7280", margin: "8px 0 2px" }}>Notes</h4>
          <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{mem.notes_freeform}</p>
        </div>
      )}
    </div>
  );
}

function Section({ title, data }: { title: string; data: unknown }): JSX.Element | null {
  if (data === null || data === undefined) return null;
  if (Array.isArray(data) && data.length === 0) return null;
  if (typeof data === "object" && Object.keys(data as object).length === 0) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <h4 style={{ fontSize: 12, color: "#6b7280", margin: "8px 0 2px" }}>{title}</h4>
      <pre
        style={{
          background: "#f9fafb",
          border: "1px solid #e5e7eb",
          borderRadius: 4,
          padding: 6,
          margin: 0,
          fontSize: 11,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}

function PrefsPanel(): JSX.Element {
  const [tone, setTone] = useState<number>(3);
  const [notes, setNotes] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await fetch("/api/memory");
      if (!r.ok) {
        setLoaded(true);
        return;
      }
      const data = (await r.json()) as MemoryRow | null;
      if (data) {
        setTone(data.rapport_tone_level ?? 3);
        setNotes(data.notes_freeform ?? "");
      }
      setLoaded(true);
    })();
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setStatus(null);
    try {
      const r = await fetch("/api/memory", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rapport_tone_level: tone, notes_freeform: notes || null }),
      });
      setStatus(r.ok ? "Saved." : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }, [tone, notes]);

  if (!loaded) return <p style={{ color: "#6b7280" }}>Loading…</p>;

  return (
    <div>
      <label style={{ display: "block", fontSize: 12, color: "#374151", marginBottom: 4 }}>
        Rapport tone (1 reserved → 5 warm)
      </label>
      <input
        type="range"
        min={1}
        max={5}
        step={1}
        value={tone}
        onChange={(e) => setTone(Number(e.target.value))}
        style={{ width: "100%" }}
      />
      <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 12 }}>Current: {tone}</div>

      <label style={{ display: "block", fontSize: 12, color: "#374151", marginBottom: 4 }}>
        Notes (anything you want the AI to remember)
      </label>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={5}
        style={{
          width: "100%",
          border: "1px solid #d1d5db",
          borderRadius: 4,
          padding: 6,
          fontSize: 12,
          fontFamily: "inherit",
        }}
      />

      <button
        onClick={() => void save()}
        disabled={saving}
        style={{
          marginTop: 8,
          padding: "6px 12px",
          fontSize: 12,
          background: "#1d4ed8",
          color: "white",
          border: "none",
          borderRadius: 4,
          cursor: saving ? "not-allowed" : "pointer",
          opacity: saving ? 0.6 : 1,
        }}
      >
        {saving ? "Saving…" : "Save"}
      </button>
      {status && (
        <p style={{ fontSize: 11, color: status === "Saved." ? "#059669" : "#b91c1c", marginTop: 6 }}>{status}</p>
      )}
    </div>
  );
}
