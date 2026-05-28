"use client";

// §38.8 — Quote-builder AI co-pilot panel (agent-facing).
//
// Stateless against the server (POST /api/agent/quote-copilot per turn);
// keeps the recent N exchanges in component state and replays them as
// `previous_turns` so the co-pilot stays coherent without server-side
// history.

import { useRef, useState } from "react";

interface Turn {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
}

const HISTORY_LIMIT = 8;

const STARTER_PROMPTS = [
  "Suggest add-ons for this cabin tier.",
  "Anything unusual about the pricing?",
  "Draft a one-paragraph rationale for the customer.",
  "What should I double-check before sending?",
];

export function QuoteCopilotPanel({ quote_id }: { quote_id: string }): JSX.Element {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const idCounter = useRef(0);
  const nextId = (prefix: string) => `${prefix}-${++idCounter.current}`;

  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setError(null);
    setSending(true);
    const userTurn: Turn = { id: nextId("u"), role: "user", content: trimmed };
    setTurns((prev) => [...prev, userTurn]);
    setInput("");
    scrollToBottom();

    // The newest HISTORY_LIMIT-1 turns make up the conversation context.
    const previous_turns = turns
      .slice(-(HISTORY_LIMIT - 1))
      .filter((t) => t.role !== "system")
      .map((t) => ({ role: t.role as "user" | "assistant", content: t.content }));

    try {
      const res = await fetch("/api/agent/quote-copilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quote_id, message: trimmed, previous_turns }),
      });
      const data = (await res.json()) as { reply?: string; error?: string; message?: string };
      if (!res.ok) {
        const fail = data.message ?? data.error ?? `status_${res.status}`;
        setError(fail);
        setTurns((prev) => [
          ...prev,
          { id: nextId("sys"), role: "system", content: fail },
        ]);
        return;
      }
      const reply = data.reply ?? "(no reply)";
      setTurns((prev) => [...prev, { id: nextId("a"), role: "assistant", content: reply }]);
      scrollToBottom();
    } catch (err) {
      setError(err instanceof Error ? err.message : "network_error");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="border border-gray-200 rounded-lg bg-white">
      <header className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-800">AI Co-Pilot</h2>
          <p className="text-xs text-gray-500">
            Suggestions for this quote — add-ons, pricing checks, customer copy.
          </p>
        </div>
        {turns.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setTurns([]);
              setError(null);
            }}
            className="text-xs text-gray-500 underline"
          >
            Clear
          </button>
        )}
      </header>

      <div
        ref={scrollRef}
        className="px-4 py-3 max-h-72 min-h-[120px] overflow-y-auto text-sm"
      >
        {turns.length === 0 ? (
          <div>
            <p className="text-xs text-gray-500 mb-3">Try a starter:</p>
            <div className="flex flex-wrap gap-2">
              {STARTER_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => void ask(p)}
                  disabled={sending}
                  className="text-xs px-2 py-1 rounded border border-gray-200 bg-gray-50 hover:bg-gray-100 text-gray-700 disabled:opacity-50"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ul className="space-y-3">
            {turns.map((t) => (
              <li key={t.id} className="flex flex-col">
                <span
                  className={
                    t.role === "user"
                      ? "text-xs font-medium text-blue-700"
                      : t.role === "system"
                        ? "text-xs font-medium text-amber-700"
                        : "text-xs font-medium text-gray-600"
                  }
                >
                  {t.role === "user" ? "You" : t.role === "system" ? "System" : "Co-Pilot"}
                </span>
                <p className="mt-0.5 text-gray-900 whitespace-pre-wrap leading-snug">{t.content}</p>
              </li>
            ))}
            {sending && (
              <li className="text-xs text-gray-500">Co-Pilot is thinking…</li>
            )}
          </ul>
        )}
      </div>

      {error && (
        <div className="px-4 py-2 bg-red-50 border-t border-red-200 text-xs text-red-700">
          {error}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
        className="border-t border-gray-200 p-3 flex gap-2"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the co-pilot…"
          disabled={sending}
          aria-label="Co-pilot prompt"
          className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="bg-blue-600 text-white px-3 py-2 rounded text-sm font-medium disabled:opacity-50 hover:bg-blue-700"
        >
          {sending ? "…" : "Ask"}
        </button>
      </form>
    </section>
  );
}
