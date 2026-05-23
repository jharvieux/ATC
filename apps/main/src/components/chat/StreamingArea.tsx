// §24.3 — Streaming message area with cursor-aware auto-scroll.
// Uses an IntersectionObserver on a bottom sentinel: if the sentinel is in
// view, auto-scroll new content; otherwise show "New message" floating
// indicator that smooth-scrolls on click.

"use client";

import { useEffect, useRef, useState } from "react";
import { MessageBubble, type ChatMessage } from "./MessageBubble";

export function StreamingArea({
  messages,
  streamingDelta,
  showMemoryIndicator,
  onFeedback,
}: {
  messages: ChatMessage[];
  streamingDelta: string | null;
  showMemoryIndicator: boolean;
  onFeedback?: (id: string, score: -1 | 1) => void;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const obs = new IntersectionObserver(
      (entries) => {
        setAtBottom(entries[0]?.isIntersecting ?? false);
      },
      { root: containerRef.current, threshold: 0, rootMargin: "0px 0px 50px 0px" },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (atBottom) {
      sentinelRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages.length, streamingDelta, atBottom]);

  function scrollToLatest(): void {
    sentinelRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  return (
    <div ref={containerRef} style={{ flex: 1, overflowY: "auto", padding: 16, position: "relative" }}>
      {messages.map((m) => (
        <MessageBubble
          key={m.id}
          msg={m}
          showMemoryIndicator={showMemoryIndicator}
          {...(onFeedback ? { onFeedback } : {})}
        />
      ))}
      {streamingDelta !== null && streamingDelta.length > 0 && (
        <MessageBubble
          msg={{
            id: "streaming",
            role: "assistant",
            content: streamingDelta,
            persona_display_name: "Assistant",
          }}
          showMemoryIndicator={false}
        />
      )}
      <div ref={sentinelRef} aria-hidden="true" />
      {!atBottom && (
        <button
          type="button"
          onClick={scrollToLatest}
          style={{
            position: "sticky",
            bottom: 12,
            float: "right",
            background: "#3b82f6",
            color: "#fff",
            border: "none",
            padding: "8px 14px",
            borderRadius: 20,
            cursor: "pointer",
          }}
        >
          New message ↓
        </button>
      )}
    </div>
  );
}
