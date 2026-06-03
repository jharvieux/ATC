"use client";

// §11.3 / chat UX — left sidebar with three tabs:
//   • History — recent conversations (read-only list)
//   • Memory — read-only view of the caller's customer_memories row
//   • Prefs  — editable subset: rapport tone level + freeform notes
//
// All three tabs use existing APIs (/api/chat/conversations, /api/memory).
// No new server work — this is purely UI assembly.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

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
    <div className="flex flex-col h-full">
      <h3 className="mt-0 mb-3 text-[15px]">Chat</h3>
      <nav className="flex gap-1 mb-3">
        {(["history", "memory", "prefs"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 text-[12px] px-1.5 py-1 border rounded capitalize cursor-pointer transition-colors ${
              tab === t
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-foreground border-input hover:bg-accent"
            }`}
          >
            {t}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto text-[13px]">
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

  if (err) return <p className="text-red-700 dark:text-red-400">Couldn&apos;t load history: {err}</p>;
  if (!convos) return <p className="text-muted-foreground">Loading…</p>;
  if (convos.length === 0) return <p className="text-muted-foreground">No conversations yet.</p>;

  return (
    <ul className="list-none p-0 m-0">
      {convos.map((c) => (
        <li key={c.id} className="mb-2">
          <a
            href={`/chat?id=${c.id}`}
            className="block text-primary no-underline overflow-hidden text-ellipsis whitespace-nowrap hover:underline"
          >
            {c.title ?? "(untitled)"}
          </a>
          <span className="text-muted-foreground text-[11px]">
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

  if (err) return <p className="text-red-700 dark:text-red-400">Couldn&apos;t load memory: {err}</p>;
  if (mem === "empty") return <p className="text-muted-foreground">No memory yet — keep chatting and we&apos;ll learn.</p>;
  if (!mem) return <p className="text-muted-foreground">Loading…</p>;

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
        <div className="mt-2">
          <h4 className="text-[12px] text-muted-foreground mt-2 mb-0.5">Notes</h4>
          <p className="m-0 whitespace-pre-wrap">{mem.notes_freeform}</p>
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
    <div className="mt-2">
      <h4 className="text-[12px] text-muted-foreground mt-2 mb-0.5">{title}</h4>
      <pre className="bg-muted border border-border rounded p-1.5 m-0 text-[11px] whitespace-pre-wrap break-words">
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

  if (!loaded) return <p className="text-muted-foreground">Loading…</p>;

  return (
    <div>
      <label className="block text-[12px] text-foreground mb-1">
        Rapport tone (1 reserved → 5 warm)
      </label>
      <input
        type="range"
        min={1}
        max={5}
        step={1}
        value={tone}
        onChange={(e) => setTone(Number(e.target.value))}
        className="w-full"
      />
      <div className="text-[11px] text-muted-foreground mb-3">Current: {tone}</div>

      <label className="block text-[12px] text-foreground mb-1">
        Notes (anything you want the AI to remember)
      </label>
      <Textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={5}
        className="text-[12px]"
      />

      <Button
        onClick={() => void save()}
        disabled={saving}
        className="mt-2 text-[12px] h-8 px-3"
      >
        {saving ? "Saving…" : "Save"}
      </Button>
      {status && (
        <p className={`text-[11px] mt-1.5 ${status === "Saved." ? "text-emerald-600 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
          {status}
        </p>
      )}
    </div>
  );
}
