"use client";

// §38.8.1 / §39.5 — Token-gated customer chat panel.
//
// Mounts on /q/[token] (customer quote view) and /i/[token] (trip
// itinerary). Posts to /api/public/chat/[token]. Stateless on the
// server — the panel keeps recent turns in component state and replays
// them as previous_turns so the AI stays coherent.

import { useRef, useState } from "react";

interface Turn {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
}

const HISTORY_LIMIT = 8;

const STARTER_PROMPTS_QUOTE = [
  "What's included in this quote?",
  "When does this need to be decided?",
  "How does this cabin compare to others?",
];

const STARTER_PROMPTS_ITINERARY = [
  "What should I pack?",
  "Tell me about the ports.",
  "When does boarding open?",
];

interface PublicTokenChatPanelProps {
  token: string;
  /** Drives the starter prompt set. Doesn't affect the request. */
  surface: "quote" | "itinerary";
  title?: string;
}

export function PublicTokenChatPanel({
  token,
  surface,
  title = "AI Travel Assistant",
}: PublicTokenChatPanelProps): JSX.Element {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const idCounter = useRef(0);
  const nextId = (prefix: string) => `${prefix}-${++idCounter.current}`;

  const starters = surface === "quote" ? STARTER_PROMPTS_QUOTE : STARTER_PROMPTS_ITINERARY;

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

    const previous_turns = turns
      .slice(-(HISTORY_LIMIT - 1))
      .filter((t) => t.role !== "system")
      .map((t) => ({ role: t.role as "user" | "assistant", content: t.content }));

    try {
      const res = await fetch(`/api/public/chat/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: trimmed, previous_turns }),
      });
      const data = (await res.json()) as { reply?: string; error?: string; message?: string };
      if (!res.ok) {
        const fail = data.message ?? data.error ?? `status_${res.status}`;
        setError(fail);
        setTurns((prev) => [...prev, { id: nextId("sys"), role: "system", content: fail }]);
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
    <section
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 10,
        background: "#fff",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <header
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#1f4e79" }}>{title}</div>
          <div style={{ fontSize: 11, color: "#6b7280" }}>
            AI — for changes to your booking, talk to your agent.
          </div>
        </div>
        {turns.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setTurns([]);
              setError(null);
            }}
            style={{
              fontSize: 12,
              color: "#6b7280",
              background: "none",
              border: "none",
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            Clear
          </button>
        )}
      </header>

      <div
        ref={scrollRef}
        style={{
          padding: "12px 16px",
          maxHeight: 320,
          minHeight: 120,
          overflowY: "auto",
          fontSize: 14,
        }}
      >
        {turns.length === 0 ? (
          <div>
            <p style={{ fontSize: 12, color: "#6b7280", marginTop: 0, marginBottom: 10 }}>
              Try one of these:
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {starters.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => void ask(p)}
                  disabled={sending}
                  style={{
                    fontSize: 12,
                    padding: "4px 8px",
                    border: "1px solid #e5e7eb",
                    background: "#f9fafb",
                    color: "#374151",
                    borderRadius: 999,
                    cursor: sending ? "not-allowed" : "pointer",
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {turns.map((t) => (
              <li key={t.id} style={{ marginBottom: 14 }}>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: t.role === "user" ? "#1f4e79" : t.role === "system" ? "#92400e" : "#374151",
                  }}
                >
                  {t.role === "user" ? "You" : t.role === "system" ? "Note" : "Assistant"}
                </span>
                <p
                  style={{
                    margin: "2px 0 0 0",
                    color: "#111827",
                    whiteSpace: "pre-wrap",
                    lineHeight: 1.4,
                  }}
                >
                  {t.content}
                </p>
              </li>
            ))}
            {sending && (
              <li style={{ fontSize: 12, color: "#6b7280" }}>Assistant is thinking…</li>
            )}
          </ul>
        )}
      </div>

      {error && (
        <div
          style={{
            padding: "8px 16px",
            background: "#fee2e2",
            borderTop: "1px solid #fecaca",
            color: "#991b1b",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
        style={{
          borderTop: "1px solid #e5e7eb",
          padding: 12,
          display: "flex",
          gap: 6,
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask anything about your trip…"
          disabled={sending}
          aria-label="Message"
          style={{
            flex: 1,
            padding: "8px 10px",
            border: "1px solid #d1d5db",
            borderRadius: 6,
            fontSize: 14,
          }}
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          style={{
            background: "#1f4e79",
            color: "#fff",
            border: "none",
            padding: "0 16px",
            borderRadius: 6,
            cursor: sending ? "not-allowed" : "pointer",
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          {sending ? "…" : "Send"}
        </button>
      </form>
    </section>
  );
}
