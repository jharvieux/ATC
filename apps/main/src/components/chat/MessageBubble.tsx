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
  showSources = true,
  onFeedback,
}: {
  msg: ChatMessage;
  showMemoryIndicator: boolean;
  /** §21.6 tenant source-display toggle. When false: hides the source
   *  expand-panel under MessageSources AND strips display_asset markup
   *  from the rendered body (per BP39 §33.7.4 follow-up). */
  showSources?: boolean;
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
      <div className="my-3 p-2.5 bg-muted rounded-md text-muted-foreground text-[14px]">
        {msg.content}
      </div>
    );
  }

  return (
    <div
      className={`flex gap-3 items-start my-3 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}
    >
      <div
        title={
          isAssistant && msg.used_memory && showMemoryIndicator
            ? "This response used context from your previous conversations."
            : undefined
        }
        className={`w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-semibold shrink-0 text-white ${msg.role === "user" ? "bg-primary" : "bg-emerald-500"}`}
      >
        {msg.role === "user" ? "You" : (msg.persona_display_name ?? "AI").slice(0, 2)}
      </div>
      <div className="max-w-[70%]">
        {isAssistant && (
          <div className="text-[12px] text-muted-foreground mb-0.5">
            {msg.persona_display_name ?? msg.persona_slug ?? "Assistant"}
            <span title={msg.created_at} className="ml-2">
              {relativeTime(msg.created_at)}
            </span>
          </div>
        )}
        <div
          className={`px-3.5 py-2.5 rounded-xl whitespace-pre-wrap ${msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"}`}
        >
          {isAssistant
            ? renderMessageContent(msg.content, msg.assets, { showAssetLinks: showSources })
            : msg.content}
        </div>
        {isAssistant && (
          <div className="mt-1.5 flex gap-2 items-center text-[12px] text-muted-foreground">
            {msg.citations && msg.citations.length > 0 && (
              <MessageSources citations={msg.citations} visible={showSources} />
            )}
            <button
              type="button"
              onClick={copy}
              aria-label="Copy message"
              className="border-none bg-transparent cursor-pointer text-muted-foreground"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              onClick={() => handleFeedback(1)}
              aria-label="Thumbs up"
              aria-pressed={score === 1}
              className={`border-none bg-transparent cursor-pointer ${score === 1 ? "text-emerald-500" : "text-muted-foreground"}`}
            >
              👍
            </button>
            <button
              type="button"
              onClick={() => handleFeedback(-1)}
              aria-label="Thumbs down"
              aria-pressed={score === -1}
              className={`border-none bg-transparent cursor-pointer ${score === -1 ? "text-red-500" : "text-muted-foreground"}`}
            >
              👎
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
