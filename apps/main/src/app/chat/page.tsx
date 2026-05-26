"use client";

// §24 — Production chat surface.
//
// Desktop: 3-pane (sidebar / chat / optional right pane). Mobile: single-pane
// with sticky compose at bottom. Persistent AI disclosure at the top.
//
// The SSE consumer reads events from POST /api/chat and routes them to the
// streaming area, signup wall, hard-limit message, escalation, etc.

import { useEffect, useRef, useState } from "react";
import { AIDisclosureBanner } from "@/components/chat/AIDisclosureBanner";
import { StreamingArea } from "@/components/chat/StreamingArea";
import type { ChatMessage } from "@/components/chat/MessageBubble";
import { SignupWall } from "@/components/chat/SignupWall";
import { HardLimitMessage } from "@/components/chat/HardLimitMessage";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { PoweredBy } from "@/components/branding/PoweredBy";

const DRAFT_KEY = "atc-chat-draft";

type SseEvent =
  | { type: "delta"; text: string }
  // BP24 streaming events — see apps/main/src/app/api/chat/route.ts for
  // semantics. Server falls back to fake-stream behaviour when streaming
  // is disabled, so these only fire under CHAT_STREAMING_ENABLED=true.
  | { type: "delta_start" }
  | { type: "rewriting" }
  | { type: "message_revised"; content: string }
  | { type: "message_id"; message_id: string; conversation_id: string }
  | { type: "sources"; citations: unknown[] }
  | { type: "persona"; slug: string; display_name: string }
  | { type: "hard_limit"; body: string; reset_at: string }
  | { type: "signup_wall"; body: string }
  | { type: "escalation"; body: string }
  | { type: "supervisor"; action: string; regens: number }
  | { type: "done" }
  | { type: "error"; message: string };

export default function ChatPage(): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [signupWall, setSignupWall] = useState<string | null>(null);
  const [hardLimit, setHardLimit] = useState<{ body: string; reset_at: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);

  // Restore draft from localStorage on mount; clear on submit.
  useEffect(() => {
    const d = window.localStorage.getItem(DRAFT_KEY);
    if (d) setInput(d);
  }, []);
  useEffect(() => {
    window.localStorage.setItem(DRAFT_KEY, input);
  }, [input]);

  async function send(): Promise<void> {
    const message = input.trim();
    if (!message || sending) return;

    setError(null);
    setSending(true);
    setStreaming("");

    const tempUserMsg: ChatMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      content: message,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);
    setInput("");
    window.localStorage.removeItem(DRAFT_KEY);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message,
          conversation_id: conversationIdRef.current,
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
      let citations: unknown[] = [];
      let personaName = "Assistant";

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
            case "persona":
              personaName = ev.display_name ?? ev.slug;
              break;
            case "sources":
              citations = ev.citations;
              break;
            case "message_id":
              assistantId = ev.message_id;
              conversationIdRef.current = ev.conversation_id;
              break;
            case "delta":
              assistantContent += ev.text;
              setStreaming(assistantContent);
              break;
            case "delta_start":
              // BP24: a fresh streamed attempt is starting. Reset the buffer
              // so deltas overwrite anything from a prior aborted attempt.
              assistantContent = "";
              setStreaming("");
              break;
            case "rewriting":
              // BP24: supervisor flagged the in-flight draft (mid-stream or
              // post-stream). Clear what's shown; the next delta_start will
              // begin the fresh draft.
              assistantContent = "";
              setStreaming("");
              break;
            case "message_revised":
              // BP24: final text was sanitized after streaming (e.g.
              // asset_id_validation stripped hallucinated markup). Replace
              // the displayed bubble content with the supplied final string.
              assistantContent = ev.content;
              setStreaming(assistantContent);
              break;
            case "signup_wall":
              setSignupWall(ev.body);
              break;
            case "hard_limit":
              setHardLimit({ body: ev.body, reset_at: ev.reset_at });
              break;
            case "escalation":
              setMessages((prev) => [
                ...prev,
                { id: `sys-${Date.now()}`, role: "system", content: ev.body },
              ]);
              break;
            case "supervisor":
              if (ev.regens > 0) {
                // Optional UI hint — we don't render this today.
              }
              break;
            case "error":
              setError(ev.message);
              break;
            case "done": {
              if (assistantContent) {
                type MsgCitation = NonNullable<ChatMessage["citations"]>[number];
                const baseMsg: ChatMessage = {
                  id: assistantId ?? `local-a-${Date.now()}`,
                  role: "assistant",
                  content: assistantContent,
                  persona_display_name: personaName,
                  created_at: new Date().toISOString(),
                };
                const finalMsg: ChatMessage = citations.length > 0
                  ? { ...baseMsg, citations: citations as MsgCitation[] }
                  : baseMsg;
                setMessages((prev) => [...prev, finalMsg]);
              }
              setStreaming(null);
              break;
            }
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

  async function submitFeedback(messageId: string, score: -1 | 1): Promise<void> {
    try {
      await fetch("/api/chat/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message_id: messageId, score }),
      });
    } catch {
      // best-effort
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <AIDisclosureBanner />
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <aside
          style={{
            width: 260,
            borderRight: "1px solid #e5e7eb",
            padding: 16,
          }}
          className="chat-sidebar"
        >
          <ChatSidebar />
        </aside>

        <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {signupWall && <SignupWall body={signupWall} />}
          {hardLimit && <HardLimitMessage body={hardLimit.body} resetAt={hardLimit.reset_at} />}
          <StreamingArea
            messages={messages}
            streamingDelta={streaming}
            showMemoryIndicator={true}
            onFeedback={submitFeedback}
          />

          {error && (
            <div style={{ padding: 12, background: "#fee2e2", color: "#991b1b" }}>{error}</div>
          )}

          {!hardLimit && !signupWall && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
              style={{
                display: "flex",
                gap: 8,
                padding: 12,
                borderTop: "1px solid #e5e7eb",
                background: "#fff",
              }}
            >
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type a message…"
                disabled={sending}
                aria-label="Message input"
                style={{ flex: 1, padding: 10, borderRadius: 6, border: "1px solid #d1d5db" }}
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                style={{
                  background: "#3b82f6",
                  color: "#fff",
                  border: "none",
                  padding: "0 18px",
                  borderRadius: 6,
                  cursor: sending ? "not-allowed" : "pointer",
                }}
              >
                {sending ? "…" : "Send"}
              </button>
            </form>
          )}
          {/* §16.7 — Powered-by attribution. show=true is the BYO Research /
              Professional / Sub-Host Starter floor. A future branding-aware
              variant will resolve tenant_branding.show_powered_by per-tenant;
              for now this is a constant true placeholder. */}
          <PoweredBy show={true} />
        </main>
      </div>

      <style jsx>{`
        @media (min-width: 768px) {
          .chat-sidebar {
            display: block !important;
          }
        }
      `}</style>
    </div>
  );
}
