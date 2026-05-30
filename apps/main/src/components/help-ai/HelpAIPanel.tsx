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
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "min(100vw, 480px)",
        background: "white",
        borderLeft: "1px solid #e5e7eb",
        boxShadow: "-8px 0 24px rgba(0,0,0,0.08)",
        display: "flex",
        flexDirection: "column",
        fontFamily: "system-ui, sans-serif",
        zIndex: 50,
      }}
    >
      <header style={{ padding: "0.75rem 1rem", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center" }}>
        <strong style={{ flex: 1, fontSize: 14 }}>{FLOW_LABELS[sessionType]}</strong>
        <button onClick={close} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: "#6b7280" }}>×</button>
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: "1rem", fontSize: 14 }}>
        {messages.length === 0 && !error && (
          <p style={{ color: "#6b7280" }}>
            {sessionType === "bug" && "I'll ask a few questions to capture the bug."}
            {sessionType === "feature" && "I'll ask a few questions about the feature you want."}
            {sessionType === "help" && "Ask me anything about the platform."}
          </p>
        )}
        {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              marginBottom: "0.75rem",
              padding: "0.5rem 0.75rem",
              borderRadius: 8,
              background: m.role === "user" ? "#eef2ff" : m.role === "assistant" ? "#f9fafb" : "#fef3c7",
              fontSize: 14,
              whiteSpace: "pre-wrap",
            }}
          >
            {m.content}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <footer style={{ padding: "0.75rem 1rem", borderTop: "1px solid #e5e7eb" }}>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }}
            disabled={sending || !sessionId}
            placeholder={sending ? "Sending…" : "Type your message…"}
            style={{ flex: 1, padding: "0.5rem 0.75rem", border: "1px solid #d1d5db", borderRadius: 6 }}
          />
          <button onClick={() => void send(input)} disabled={sending || !sessionId || !input.trim()} style={{ padding: "0.5rem 0.75rem", background: "#4f46e5", color: "white", border: "none", borderRadius: 6, cursor: "pointer" }}>
            Send
          </button>
        </div>
        {sessionType === "help" && (
          <button
            onClick={() => void escalate()}
            disabled={!sessionId}
            style={{ marginTop: "0.5rem", fontSize: 13, color: "#6b7280", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}
          >
            Escalate to platform support
          </button>
        )}
      </footer>
    </div>
  );
}
