// §24.4 — Message bubble with avatar, name, sources, timestamp, feedback, copy.

"use client";

import { useState } from "react";
import { MessageSources, type MessageCitation } from "./MessageSources";
import { renderMessageContent, type DisplayAsset } from "./renderMessageContent";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  persona_slug?: string | null;
  persona_display_name?: string | null;
  citations?: MessageCitation[];
  created_at?: string;
  feedback_score?: -1 | 0 | 1 | null;
  used_memory?: boolean;
  // BP39 §33.7.2 — assets surfaced by the chat SSE `assets` event.
  // Used to expand `[[display_asset:<uuid>]]` markers in `content`
  // to hyperlinks (operator override of the spec's inline-image
  // rendering — see MEMORY D-075).
  assets?: DisplayAsset[];
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  return new Date(iso).toLocaleDateString();
}

export function MessageBubble({
  msg,
  showMemoryIndicator,
  onFeedback,
}: {
  msg: ChatMessage;
  showMemoryIndicator: boolean;
  onFeedback?: (messageId: string, score: -1 | 1) => void;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [score, setScore] = useState<number | null>(msg.feedback_score ?? null);
  const isAssistant = msg.role === "assistant";
  const isSystem = msg.role === "system";

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  function handleFeedback(s: -1 | 1): void {
    setScore(s);
    onFeedback?.(msg.id, s);
  }

  if (isSystem) {
    return (
      <div style={{ margin: "12px 0", padding: 10, background: "#f1f5f9", borderRadius: 6, color: "#475569", fontSize: 14 }}>
        {msg.content}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        margin: "12px 0",
        flexDirection: msg.role === "user" ? "row-reverse" : "row",
      }}
    >
      <div
        title={isAssistant && msg.used_memory && showMemoryIndicator
          ? "This response used context from your previous conversations."
          : undefined}
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          background: msg.role === "user" ? "#3b82f6" : "#10b981",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        {msg.role === "user" ? "You" : (msg.persona_display_name ?? "AI").slice(0, 2)}
      </div>
      <div style={{ maxWidth: "70%" }}>
        {isAssistant && (
          <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 2 }}>
            {msg.persona_display_name ?? msg.persona_slug ?? "Assistant"}
            <span title={msg.created_at} style={{ marginLeft: 8 }}>
              {relativeTime(msg.created_at)}
            </span>
          </div>
        )}
        <div
          style={{
            background: msg.role === "user" ? "#3b82f6" : "#f3f4f6",
            color: msg.role === "user" ? "#fff" : "#111827",
            padding: "10px 14px",
            borderRadius: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          {isAssistant ? renderMessageContent(msg.content, msg.assets) : msg.content}
        </div>
        {isAssistant && (
          <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "#6b7280" }}>
            {msg.citations && msg.citations.length > 0 && (
              <MessageSources citations={msg.citations} />
            )}
            <button type="button" onClick={copy} aria-label="Copy message"
              style={{ border: "none", background: "transparent", cursor: "pointer", color: "#6b7280" }}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" onClick={() => handleFeedback(1)}
              aria-label="Thumbs up" aria-pressed={score === 1}
              style={{ border: "none", background: "transparent", cursor: "pointer", color: score === 1 ? "#10b981" : "#6b7280" }}>
              👍
            </button>
            <button type="button" onClick={() => handleFeedback(-1)}
              aria-label="Thumbs down" aria-pressed={score === -1}
              style={{ border: "none", background: "transparent", cursor: "pointer", color: score === -1 ? "#ef4444" : "#6b7280" }}>
              👎
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
