"use client";

// §24 — Production chat surface, extracted as a reusable client component
// so both /chat (default agent) and /chat/[slug] (per-agent, Phase 5c)
// can render it. When `personaSlug` is passed, it's forwarded on every
// POST /api/chat call — the API already accepts an optional `persona_slug`
// in the request body and resolves the matching persona via
// resolveActivePersonaSlug.
//
// Desktop: 3-pane (sidebar / chat / optional right pane). Mobile: single
// pane with sticky compose. Persistent AI disclosure at top.

import { useEffect, useRef, useState, type JSX } from "react";
import { AIDisclosureBanner } from "@/components/chat/AIDisclosureBanner";
import { NewsTickerBanner } from "@/components/chat/NewsTickerBanner";
import { StreamingArea } from "@/components/chat/StreamingArea";
import type { ChatMessage } from "@/components/chat/MessageBubble";
import { SignupWall } from "@/components/chat/SignupWall";
import { HardLimitMessage } from "@/components/chat/HardLimitMessage";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { PoweredBy } from "@/components/branding/PoweredBy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { buildChatRequestBody } from "@/components/chat/build-chat-request-body";

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

export interface ChatExperienceProps {
  /** When set, every POST /api/chat carries this slug as `persona_slug`,
   *  pinning the conversation to the chosen agent. Undefined falls back
   *  to the tenant's default persona. */
  personaSlug?: string;
}

export function ChatExperience({ personaSlug }: ChatExperienceProps): JSX.Element {
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
        body: JSON.stringify(
          buildChatRequestBody({
            message,
            conversation_id: conversationIdRef.current,
            personaSlug,
          }),
        ),
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
            // BP24: delta_start = a fresh streamed attempt is starting;
            // rewriting = supervisor flagged the in-flight draft. Both reset
            // the buffer so the next deltas overwrite anything shown so far.
            case "delta_start":
            case "rewriting":
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
    <div className="flex flex-col h-screen">
      <NewsTickerBanner />
      <AIDisclosureBanner />
      <div className="flex flex-1 overflow-hidden">
        <aside className="hidden md:block w-[260px] border-r border-border p-4 overflow-y-auto shrink-0">
          <ChatSidebar />
        </aside>

        <main className="flex-1 flex flex-col overflow-hidden">
          {signupWall && <SignupWall body={signupWall} />}
          {hardLimit && <HardLimitMessage body={hardLimit.body} resetAt={hardLimit.reset_at} />}
          <StreamingArea
            messages={messages}
            streamingDelta={streaming}
            showMemoryIndicator={true}
            onFeedback={submitFeedback}
          />

          {error && (
            <div className="p-3 bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300 text-sm">
              {error}
            </div>
          )}

          {!hardLimit && !signupWall && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                // allow-void-async: browser onSubmit handler; send()
                // manages its own loading/error state via useState and
                // cannot be awaited from a synchronous event handler.
                void send();
              }}
              className="flex gap-2 p-3 border-t border-border bg-background"
            >
              <Input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type a message…"
                disabled={sending}
                aria-label="Message input"
                className="flex-1"
              />
              <Button type="submit" disabled={sending || !input.trim()}>
                {sending ? "…" : "Send"}
              </Button>
            </form>
          )}
          {/* §16.7 — Powered-by attribution. show=true is the BYO Research /
              Professional / Sub-Host Starter floor. A future branding-aware
              variant will resolve tenant_branding.show_powered_by per-tenant;
              for now this is a constant true placeholder. */}
          <PoweredBy show={true} />
        </main>
      </div>
    </div>
  );
}
