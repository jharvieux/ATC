"use client";

// §11.3 — Customer memory controls page. The spec calls for "view, edit, and
// delete their memory at /settings/memory". This MVP wires:
//   - GET /api/memory               → display the structured memory blocks
//   - PATCH /api/memory             → clear one section at a time
//   - DELETE /api/memory            → clear everything (keeps row for FK integrity)
//
// Editing individual nested JSONB fields is out of scope at MVP (each field
// has a different shape and the data model is still maturing). Customers can
// see what's stored and selectively clear sections; a tenant agent can
// continue to use the in-chat sidebar Memory tab (D-097) for granular edits.

import { useEffect, useState } from "react";

type Memory = {
  preferences: unknown;
  travel_history: unknown;
  family_composition: unknown;
  accessibility_needs: unknown;
  dietary_restrictions: unknown;
  loyalty_programs: unknown;
  important_dates: unknown;
  notes_freeform: string | null;
  rapport_tone_level: number | null;
  rapport_signals: unknown;
  updated_at: string;
};

type SectionKey =
  | "preferences"
  | "travel_history"
  | "family_composition"
  | "accessibility_needs"
  | "dietary_restrictions"
  | "loyalty_programs"
  | "important_dates"
  | "notes_freeform"
  | "rapport_tone_level"
  | "rapport_signals";

const SECTION_LABELS: Record<SectionKey, string> = {
  preferences: "Travel preferences",
  travel_history: "Travel history",
  family_composition: "Family / companions",
  accessibility_needs: "Accessibility needs",
  dietary_restrictions: "Dietary restrictions",
  loyalty_programs: "Loyalty programs",
  important_dates: "Important dates",
  notes_freeform: "Free-form notes",
  rapport_tone_level: "Conversation tone",
  rapport_signals: "Rapport signals",
};

export default function MemoryPage(): JSX.Element {
  const [memory, setMemory] = useState<Memory | null | "none">(null);
  const [busy, setBusy] = useState<SectionKey | "all" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load(): Promise<void> {
    setError(null);
    try {
      const res = await fetch("/api/memory");
      if (!res.ok) throw new Error(`load failed: ${res.status}`);
      const body = (await res.json()) as Memory | null;
      setMemory(body ?? "none");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function clearSection(key: SectionKey): Promise<void> {
    setBusy(key);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch("/api/memory", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: null }),
      });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? "save failed");
      setMsg(`Cleared "${SECTION_LABELS[key]}".`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function clearAll(): Promise<void> {
    if (!confirm("Delete ALL stored memory? The AI will no longer remember you across conversations.")) return;
    setBusy("all");
    setError(null);
    setMsg(null);
    try {
      const res = await fetch("/api/memory", { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error("delete failed");
      setMsg("All memory cleared.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (memory === null) return <main style={{ padding: 24 }}>Loading…</main>;

  const sections: SectionKey[] = [
    "preferences",
    "travel_history",
    "family_composition",
    "accessibility_needs",
    "dietary_restrictions",
    "loyalty_programs",
    "important_dates",
    "notes_freeform",
    "rapport_tone_level",
    "rapport_signals",
  ];

  return (
    <main style={{ padding: 24, maxWidth: 760, margin: "0 auto" }}>
      <h1>Memory</h1>
      <p style={{ color: "#555" }}>
        What the AI remembers about you across conversations. You can clear any
        section individually or delete everything. To stop the AI from learning
        more, visit <a href="/settings/privacy">Privacy</a> and turn on
        &ldquo;Opt out of personalization memory.&rdquo;
      </p>

      {error && <div style={{ background: "#fee2e2", padding: 12, borderRadius: 6, marginTop: 12 }}>{error}</div>}
      {msg && <div style={{ background: "#dcfce7", padding: 12, borderRadius: 6, marginTop: 12 }}>{msg}</div>}

      {memory === "none" ? (
        <section style={{ padding: 16, border: "1px solid #e5e7eb", borderRadius: 8, marginTop: 16, color: "#555" }}>
          No memory stored yet. The AI will start building context as you chat.
        </section>
      ) : (
        <>
          {sections.map((key) => {
            const value = memory[key];
            const isEmpty =
              value === null ||
              value === undefined ||
              (typeof value === "string" && value.trim() === "") ||
              (Array.isArray(value) && value.length === 0) ||
              (typeof value === "object" && value !== null && Object.keys(value as Record<string, unknown>).length === 0);
            return (
              <section
                key={key}
                style={{
                  padding: 16,
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  marginTop: 12,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                  <strong>{SECTION_LABELS[key]}</strong>
                  {!isEmpty && (
                    <button
                      onClick={() => clearSection(key)}
                      disabled={busy !== null}
                      style={{
                        padding: "4px 10px",
                        fontSize: 13,
                        border: "1px solid #d1d5db",
                        borderRadius: 4,
                        background: "white",
                        cursor: "pointer",
                      }}
                    >
                      {busy === key ? "Clearing…" : "Clear"}
                    </button>
                  )}
                </div>
                <pre
                  style={{
                    margin: "8px 0 0 0",
                    padding: 8,
                    background: "#f9fafb",
                    borderRadius: 4,
                    fontSize: 13,
                    color: isEmpty ? "#9ca3af" : "#111827",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {isEmpty ? "(empty)" : JSON.stringify(value, null, 2)}
                </pre>
              </section>
            );
          })}

          <hr style={{ margin: "24px 0", border: 0, borderTop: "1px solid #e5e7eb" }} />

          <section style={{ padding: 16, border: "1px solid #fca5a5", background: "#fef2f2", borderRadius: 8 }}>
            <strong>Delete all memory</strong>
            <p style={{ color: "#555", fontSize: 14, margin: "4px 0 12px 0" }}>
              Removes every stored fact. The conversation row itself is kept for
              tenant operational records, but its memory contents will be empty.
              You can keep using the AI; it just won&rsquo;t remember anything
              from prior conversations.
            </p>
            <button
              onClick={clearAll}
              disabled={busy !== null}
              style={{
                padding: "8px 14px",
                fontSize: 14,
                color: "white",
                background: "#dc2626",
                border: 0,
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              {busy === "all" ? "Deleting…" : "Delete all memory"}
            </button>
          </section>
        </>
      )}
    </main>
  );
}
