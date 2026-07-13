"use client";

// #1781/#1791 — extracted from ConciergeExperience.tsx (was a 925-line file
// with 4 sub-components defined inline). Renders the "Memory" sidebar tab:
// the customer_memories row for the active conversation's customer.

import { useEffect, useState } from "react";

interface MemoryRow {
  preferences?: Record<string, unknown> | null;
  travel_history?: Record<string, unknown> | null;
  family_composition?: unknown[] | null;
  accessibility_needs?: Record<string, unknown> | null;
  dietary_restrictions?: Record<string, unknown> | null;
  loyalty_programs?: unknown[] | null;
  important_dates?: Record<string, unknown> | null;
  notes_freeform?: string | null;
}

const MEMORY_ICONS: Record<string, string> = {
  preferences: "⚙️",
  travel_history: "🗺️",
  family_composition: "👨‍👩‍👧",
  accessibility_needs: "♿",
  dietary_restrictions: "🍽️",
  loyalty_programs: "🎖️",
  important_dates: "📅",
  notes_freeform: "📝",
};

const MEMORY_LABELS: Record<string, string> = {
  preferences: "Preferences",
  travel_history: "Travel history",
  family_composition: "Family",
  accessibility_needs: "Accessibility",
  dietary_restrictions: "Dietary",
  loyalty_programs: "Loyalty",
  important_dates: "Dates",
  notes_freeform: "Notes",
};

export function TaMemoryPanel(): React.JSX.Element {
  const [mem, setMem] = useState<MemoryRow | null | "loading">("loading");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/memory");
        if (!r.ok) { setErr(`HTTP ${r.status}`); return; }
        const data = (await r.json()) as MemoryRow | null;
        setMem(data ?? null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  if (err) {
    return (
      <p style={{ fontSize: 12, color: "#F87171" }}>Could not load memory: {err}</p>
    );
  }
  if (mem === "loading") {
    return <p style={{ fontSize: 12, color: "var(--ta-text-mute)" }}>Loading…</p>;
  }
  if (!mem) {
    return (
      <p style={{ fontSize: 12, color: "var(--ta-text-mute)" }}>
        No client memory yet — keep chatting and it will appear here.
      </p>
    );
  }

  const entries = Object.entries(mem).filter(([, v]) => {
    if (v === null || v === undefined) return false;
    if (Array.isArray(v) && v.length === 0) return false;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) return false;
    return true;
  });

  if (entries.length === 0) {
    return (
      <p style={{ fontSize: 12, color: "var(--ta-text-mute)" }}>
        No client memory yet — keep chatting and it will appear here.
      </p>
    );
  }

  return (
    <div>
      {entries.map(([key, val]) => (
        <div
          key={key}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: "7px 8px",
            borderRadius: 7,
            marginBottom: 3,
            background: "var(--ta-surface-2)",
            border: "1px solid var(--ta-border)",
          }}
        >
          <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>
            {MEMORY_ICONS[key] ?? "💡"}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                color: "var(--ta-text-mute)",
                marginBottom: 2,
              }}
            >
              {MEMORY_LABELS[key] ?? key}
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--ta-text-soft)",
                fontFamily: "var(--font-geist-mono, monospace)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {typeof val === "string"
                ? val
                : JSON.stringify(val, null, 2)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
