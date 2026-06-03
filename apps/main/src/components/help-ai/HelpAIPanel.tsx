"use client";

// BP31 §32.2.3 — Help AI slide-over panel.
//
// Opens from the right (~480px on desktop, full-screen on mobile).
// Header: flow type + close button. Body: conversation messages.
// Footer: input + send + "Escalate to platform support" (help flow only).
//
// Behavior:
//   1. On mount, POST /api/help/sessions to open a new help_sessions row.
//   2. Each user message is sent to POST /api/help/sessions/[id]/message,
//      which returns text/event-stream from the Help AI.
//   3. SSE chunks are appended to the assistant message in real time.
//   4. On close, POST /api/help/sessions/[id]/close with outcome.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Props {
  sessionType: "help" | "bug" | "feature";
  sourceSurface: "admin" | "customer_chat";
  onClose: () => void;
}

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

// §17.x — session is in HttpOnly cookies that ride along same-origin fetches;
// no Bearer to attach. Helper kept so call sites don't churn.
async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(path, { ...init, headers });
}

const FLOW_LABELS: Record<Props["sessionType"], string> = {
  help: "I need help",
  bug: "Report a bug",
  feature: "Request a feature",
};

// §24.7 draft autosave — per-flow localStorage key. Help bug/feature flows
// often involve longer-form input than the help-Q&A; a closed tab or
// accidental refresh shouldn't lose the in-progress text. Per-flow key
// so a bug-report draft doesn't appear in the feature-request box.
function draftKeyFor(sessionType: Props["sessionType"]): string {
  return `atc-help-ai-draft:${sessionType}`;
}

export function HelpAIPanel({ sessionType, sourceSurface, onClose }: Props): JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Restore draft on mount; clear on send.
  useEffect(() => {
    const d = window.localStorage.getItem(draftKeyFor(sessionType));
    if (d) setInput(d);
  }, [sessionType]);
  useEffect(() => {
    window.localStorage.setItem(draftKeyFor(sessionType), input);
  }, [input, sessionType]);

  useEffect(() => {
    (async () => {
      const res = await authFetch("/api/help/sessions", {
        method: "POST",
        body: JSON.stringify({ session_type: sessionType, source_surface: sourceSurface }),
      });
      if (!res.ok) {
        setError("Could not open a help session.");
        return;
      }
      const body = (await res.json()) as { session_id: string };
      setSessionId(body.session_id);
    })();
  }, [sessionType, sourceSurface]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(text: string): Promise<void> {
    if (!sessionId || !text.trim() || sending) return;
    setSending(true);
    setError(null);
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    // §24.7 — clear the draft once submitted.
    window.localStorage.removeItem(draftKeyFor(sessionType));

    try {
      const res = await authFetch(`/api/help/sessions/${sessionId}/message`, {
        method: "POST",
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok || !res.body) {
        setError("The Help AI didn't respond. Try again or escalate to platform support.");
        return;
      }

      // Stream the assistant response chunk by chunk.
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        // SSE frames are `data: <text>\n\n`. Concatenate the data: lines.
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data: ")) {
            const piece = line.slice(6);
            if (piece === "[DONE]") continue;
            // BP24 option B UX — server emits this sentinel before a
            // fallback message when the per-sentence supervisor aborts a
            // streamed draft. Clear what's on screen; the next data frame
            // is the replacement.
            if (piece === "[REWRITE]") {
              assistantText = "";
              setMessages((prev) => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                if (last && last.role === "assistant") last.content = "";
                return copy;
              });
              continue;
            }
            assistantText += piece;
            setMessages((prev) => {
              const copy = [...prev];
              const last = copy[copy.length - 1];
              if (last && last.role === "assistant") last.content = assistantText;
              return copy;
            });
          }
        }
      }
    } finally {
      setSending(false);
    }
  }

  async function escalate(): Promise<void> {
    if (!sessionId) return;
    await authFetch(`/api/help/sessions/${sessionId}/escalate`, {
      method: "POST",
      body: JSON.stringify({ escalation_reason: "user-initiated" }),
    });
    setMessages((prev) => [...prev, { role: "system", content: "Your session has been escalated to platform support. Someone will follow up." }]);
  }

  async function close(): Promise<void> {
    if (sessionId) {
      await authFetch(`/api/help/sessions/${sessionId}/close`, {
        method: "POST",
        body: JSON.stringify({ outcome: messages.length > 0 ? "resolved" : "abandoned" }),
      });
    }
    onClose();
  }

  return (
    <div className="fixed top-0 right-0 bottom-0 w-[min(100vw,480px)] bg-background border-l border-border shadow-[-8px_0_24px_rgba(0,0,0,0.08)] flex flex-col z-50">
      <header className="py-3 px-4 border-b border-border flex items-center">
        <strong className="flex-1 text-[14px]">{FLOW_LABELS[sessionType]}</strong>
        <button
          onClick={close}
          className="bg-transparent border-none cursor-pointer text-[16px] text-muted-foreground hover:text-foreground"
        >
          ×
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4 text-[14px]">
        {messages.length === 0 && !error && (
          <p className="text-muted-foreground">
            {sessionType === "bug" && "I'll ask a few questions to capture the bug."}
            {sessionType === "feature" && "I'll ask a few questions about the feature you want."}
            {sessionType === "help" && "Ask me anything about the platform."}
          </p>
        )}
        {error && <p className="text-red-700 dark:text-red-400">{error}</p>}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`mb-3 px-3 py-2 rounded-lg text-[14px] whitespace-pre-wrap ${
              m.role === "user"
                ? "bg-primary/10 dark:bg-primary/20"
                : m.role === "assistant"
                  ? "bg-muted"
                  : "bg-amber-50 dark:bg-amber-900/30"
            }`}
          >
            {m.content}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <footer className="py-3 px-4 border-t border-border">
        <div className="flex gap-2">
          <Input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }}
            disabled={sending || !sessionId}
            placeholder={sending ? "Sending…" : "Type your message…"}
            className="flex-1"
          />
          <Button
            onClick={() => void send(input)}
            disabled={sending || !sessionId || !input.trim()}
          >
            Send
          </Button>
        </div>
        {sessionType === "help" && (
          <button
            onClick={() => void escalate()}
            disabled={!sessionId}
            className="mt-2 text-[13px] text-muted-foreground bg-transparent border-none cursor-pointer underline"
          >
            Escalate to platform support
          </button>
        )}
      </footer>
    </div>
  );
}
