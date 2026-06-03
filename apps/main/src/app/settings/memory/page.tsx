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
import { Button } from "@/components/ui/button";

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

  if (memory === null) return <main className="p-6">Loading…</main>;

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
    <main className="p-6 max-w-[760px] mx-auto">
      <h1>Memory</h1>
      <p className="text-muted-foreground">
        What the AI remembers about you across conversations. You can clear any
        section individually or delete everything. To stop the AI from learning
        more, visit <a href="/settings/privacy" className="text-primary hover:underline">Privacy</a> and turn on
        &ldquo;Opt out of personalization memory.&rdquo;
      </p>

      {error && <div className="bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300 p-3 rounded-md mt-3">{error}</div>}
      {msg && <div className="bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 p-3 rounded-md mt-3">{msg}</div>}

      {memory === "none" ? (
        <section className="p-4 border border-border rounded-lg mt-4 text-muted-foreground">
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
                className="p-4 border border-border rounded-lg mt-3"
              >
                <div className="flex justify-between items-baseline gap-3">
                  <strong>{SECTION_LABELS[key]}</strong>
                  {!isEmpty && (
                    <Button
                      variant="outline"
                      onClick={() => clearSection(key)}
                      disabled={busy !== null}
                      className="h-7 text-[13px] px-2.5"
                    >
                      {busy === key ? "Clearing…" : "Clear"}
                    </Button>
                  )}
                </div>
                <pre
                  className={`mt-2 mb-0 p-2 bg-muted rounded text-[13px] whitespace-pre-wrap break-words ${isEmpty ? "text-muted-foreground" : "text-foreground"}`}
                >
                  {isEmpty ? "(empty)" : JSON.stringify(value, null, 2)}
                </pre>
              </section>
            );
          })}

          <hr className="my-6 border-0 border-t border-border" />

          <section className="p-4 border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/30 rounded-lg">
            <strong>Delete all memory</strong>
            <p className="text-muted-foreground text-[14px] mt-1 mb-3">
              Removes every stored fact. The conversation row itself is kept for
              tenant operational records, but its memory contents will be empty.
              You can keep using the AI; it just won&rsquo;t remember anything
              from prior conversations.
            </p>
            <Button
              variant="default"
              onClick={clearAll}
              disabled={busy !== null}
              className="bg-red-600 hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600"
            >
              {busy === "all" ? "Deleting…" : "Delete all memory"}
            </Button>
          </section>
        </>
      )}
    </main>
  );
}
