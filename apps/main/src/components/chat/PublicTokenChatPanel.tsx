"use client";

// §38.8.1 / §39.5 — Token-gated customer chat panel.
//
// Mounts on /q/[token] (customer quote view) and /i/[token] (trip
// itinerary). Posts to /api/public/chat/[token]. Stateless on the
// server — the panel keeps recent turns in component state and replays
// them as previous_turns so the AI stays coherent.

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
    <section className="border border-border rounded-[10px] bg-card">
      <header className="px-4 py-3 border-b border-border flex justify-between items-center">
        <div>
          <div className="text-[14px] font-semibold text-primary">{title}</div>
          <div className="text-[11px] text-muted-foreground">
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
            className="text-[12px] text-muted-foreground bg-transparent border-none cursor-pointer underline"
          >
            Clear
          </button>
        )}
      </header>

      <div
        ref={scrollRef}
        className="px-4 py-3 max-h-80 min-h-[120px] overflow-y-auto text-[14px]"
      >
        {turns.length === 0 ? (
          <div>
            <p className="text-[12px] text-muted-foreground mt-0 mb-2.5">Try one of these:</p>
            <div className="flex flex-wrap gap-1.5">
              {starters.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => void ask(p)}
                  disabled={sending}
                  className="text-[12px] px-2 py-1 border border-border bg-muted text-foreground rounded-full cursor-pointer hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ul className="m-0 p-0 list-none">
            {turns.map((t) => (
              <li key={t.id} className="mb-3.5">
                <span
                  className={`text-[11px] font-semibold ${
                    t.role === "user"
                      ? "text-primary"
                      : t.role === "system"
                        ? "text-amber-700 dark:text-amber-400"
                        : "text-foreground"
                  }`}
                >
                  {t.role === "user" ? "You" : t.role === "system" ? "Note" : "Assistant"}
                </span>
                <p className="mt-0.5 mb-0 text-foreground whitespace-pre-wrap leading-[1.4]">
                  {t.content}
                </p>
              </li>
            ))}
            {sending && (
              <li className="text-[12px] text-muted-foreground">Assistant is thinking…</li>
            )}
          </ul>
        )}
      </div>

      {error && (
        <div className="px-4 py-2 bg-red-100 dark:bg-red-900/30 border-t border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 text-[12px]">
          {error}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
        className="border-t border-border p-3 flex gap-1.5"
      >
        <Input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask anything about your trip…"
          disabled={sending}
          aria-label="Message"
          className="flex-1"
        />
        <Button type="submit" disabled={sending || !input.trim()}>
          {sending ? "…" : "Send"}
        </Button>
      </form>
    </section>
  );
}
