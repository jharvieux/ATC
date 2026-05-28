"use client";

// §20.4 / §38.8.1 / §39.5 — Embeddable customer-facing AI chat panel.
//
// Mounts inside any customer-facing surface (booking flow, customer quote
// view, trip itinerary, etc.) and exchanges messages with /api/chat over
// SSE. Passes `customer_context_ref` so the server can fetch the
// associated booking / quote / itinerary and inject it into the system
// prompt.
//
// Auth model: this panel forwards the user's existing cookies / Bearer
// token to /api/chat — it does NOT do anything special. If the surface
// requires an authenticated user (booking flow), that's enforced by the
// surrounding page. For token-gated public surfaces (e.g., /i/[token]),
// a future tokenized chat endpoint can wrap the same SSE pattern.

import { useEffect, useRef, useState } from "react";
import type { CustomerContextRef } from "@/lib/chat/customer-context";

interface ChatBubble {
  role: "user" | "assistant" | "system";
  content: string;
  id: string;
}

interface SseEvent {
  type: string;
  text?: string;
  content?: string;
  body?: string;
  message?: string;
  message_id?: string;
  conversation_id?: string;
  display_name?: string;
  slug?: string;
}

interface CustomerContextChatPanelProps {
  /** What this customer is currently looking at — drives system-prompt context. */
  contextRef: CustomerContextRef;
  /** Display title above the chat (e.g., "AI Travel Assistant"). */
  title?: string;
  /** Optional placeholder for the input box. */
  placeholder?: string;
  /** Optional max height for the message scroller, in px. Default 360. */
  maxHeight?: number;
}

const DEFAULT_TITLE = "AI Travel Assistant";
const DEFAULT_PLACEHOLDER = "Ask about your trip…";

export function CustomerContextChatPanel({
  contextRef,
  title = DEFAULT_TITLE,
  placeholder = DEFAULT_PLACEHOLDER,
  maxHeight = 360,
}: CustomerContextChatPanelProps): JSX.Element {
  const [bubbles, setBubbles] = useState<ChatBubble[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [bubbles, streaming]);

  async function send(): Promise<void> {
    const message = input.trim();
    if (!message || sending) return;
    setError(null);
    setSending(true);
    setStreaming("");

    const userBubble: ChatBubble = {
      id: `u-${Date.now()}`,
      role: "user",
      content: message,
    };
    setBubbles((prev) => [...prev, userBubble]);
    setInput("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message,
          conversation_id: conversationIdRef.current,
          customer_context_ref: contextRef,
        }),
      });
      if (!res.ok || !res.body) {
        const txt = await res.text();
        throw new Error(txt || `status ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let assistantContent = "";
      let assistantId: string | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const ev = JSON.parse(line.slice(6)) as SseEvent;
          switch (ev.type) {
            case "message_id":
              assistantId = ev.message_id ?? null;
              conversationIdRef.current = ev.conversation_id ?? null;
              break;
            case "delta":
              if (ev.text) {
                assistantContent += ev.text;
                setStreaming(assistantContent);
              }
              break;
            case "delta_start":
              assistantContent = "";
              setStreaming("");
              break;
            case "rewriting":
              assistantContent = "";
              setStreaming("");
              break;
            case "message_revised":
              if (ev.content !== undefined) {
                assistantContent = ev.content;
                setStreaming(assistantContent);
              }
              break;
            case "hard_limit":
            case "signup_wall":
            case "escalation":
              if (ev.body) {
                setBubbles((prev) => [
                  ...prev,
                  { id: `sys-${Date.now()}`, role: "system", content: ev.body ?? "" },
                ]);
              }
              break;
            case "error":
              setError(ev.message ?? "error");
              break;
            case "done":
              if (assistantContent) {
                setBubbles((prev) => [
                  ...prev,
                  {
                    id: assistantId ?? `a-${Date.now()}`,
                    role: "assistant",
                    content: assistantContent,
                  },
                ]);
              }
              setStreaming(null);
              break;
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStreaming(null);
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h3 style={{ fontSize: 14, fontWeight: 700, color: "#374151", margin: 0 }}>
        {title}
      </h3>
      <p style={{ fontSize: 11, color: "#9ca3af", margin: 0 }}>
        AI — replies may include errors. Confirm anything important with your agent.
      </p>

      <div
        ref={scrollRef}
        style={{
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 6,
          padding: 10,
          maxHeight,
          minHeight: 120,
          overflowY: "auto",
          fontSize: 13,
        }}
      >
        {bubbles.length === 0 && !streaming && (
          <p style={{ color: "#9ca3af", margin: 0 }}>
            Ask me anything about your trip — cabins, ports, packing, timing, options.
          </p>
        )}
        {bubbles.map((b) => (
          <Bubble key={b.id} bubble={b} />
        ))}
        {streaming !== null && (
          <Bubble bubble={{ id: "streaming", role: "assistant", content: streaming || "…" }} />
        )}
      </div>

      {error && (
        <div
          style={{
            background: "#fee2e2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            padding: "6px 8px",
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        style={{ display: "flex", gap: 6 }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder}
          disabled={sending}
          aria-label="Message"
          style={{
            flex: 1,
            padding: "8px 10px",
            border: "1px solid #d1d5db",
            borderRadius: 4,
            fontSize: 13,
          }}
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          style={{
            background: "#3b82f6",
            color: "#fff",
            border: "none",
            padding: "0 12px",
            borderRadius: 4,
            cursor: sending ? "not-allowed" : "pointer",
            fontSize: 13,
          }}
        >
          {sending ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}

function Bubble({ bubble }: { bubble: ChatBubble }): JSX.Element {
  const isUser = bubble.role === "user";
  const isSystem = bubble.role === "system";
  return (
    <div
      style={{
        marginBottom: 8,
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
      }}
    >
      <div
        style={{
          background: isSystem ? "#fef3c7" : isUser ? "#dbeafe" : "#f3f4f6",
          color: "#111827",
          padding: "6px 10px",
          borderRadius: 8,
          maxWidth: "85%",
          whiteSpace: "pre-wrap",
          fontSize: 13,
          lineHeight: 1.4,
        }}
      >
        {bubble.content}
      </div>
    </div>
  );
}
