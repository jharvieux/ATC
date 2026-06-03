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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
    <div className="flex flex-col gap-2">
      <h3 className="text-[14px] font-bold text-foreground m-0">{title}</h3>
      <p className="text-[11px] text-muted-foreground m-0">
        AI — replies may include errors. Confirm anything important with your agent.
      </p>

      <div
        ref={scrollRef}
        className="bg-background border border-border rounded-md p-2.5 min-h-[120px] overflow-y-auto text-[13px]"
        style={{ maxHeight }} /* prop-driven; can't be a static Tailwind class */
      >
        {bubbles.length === 0 && !streaming && (
          <p className="text-muted-foreground m-0">
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
        <div className="bg-red-100 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 px-2 py-1.5 rounded text-[12px]">
          {error}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="flex gap-1.5"
      >
        <Input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder}
          disabled={sending}
          aria-label="Message"
          className="flex-1 text-[13px]"
        />
        <Button type="submit" disabled={sending || !input.trim()}>
          {sending ? "…" : "Send"}
        </Button>
      </form>
    </div>
  );
}

function Bubble({ bubble }: { bubble: ChatBubble }): JSX.Element {
  const isUser = bubble.role === "user";
  const isSystem = bubble.role === "system";
  return (
    <div className={`mb-2 flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`px-2.5 py-1.5 rounded-lg max-w-[85%] whitespace-pre-wrap text-[13px] leading-[1.4] text-foreground ${
          isSystem
            ? "bg-amber-50 dark:bg-amber-900/30"
            : isUser
              ? "bg-blue-100 dark:bg-blue-900/30"
              : "bg-muted"
        }`}
      >
        {bubble.content}
      </div>
    </div>
  );
}
