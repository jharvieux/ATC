// §24.3 — Streaming message area with cursor-aware auto-scroll.
// Uses an IntersectionObserver on a bottom sentinel: if the sentinel is in
// view, auto-scroll new content; otherwise show "New message" floating
// indicator that smooth-scrolls on click.
//
// Auto-scroll always fires when the last message is from the user so the reply
// is visible even if they scrolled up mid-conversation before hitting Send.

"use client";

import { useEffect, useRef, useState } from "react";
import { MessageBubble, type ChatMessage } from "./MessageBubble";

function ThinkingBubble(): React.JSX.Element {
  return (
    <div className="flex gap-3 items-start my-3" role="status" aria-label="Assistant is responding">
      {/* Avatar matches assistant bubble style in MessageBubble */}
      <div className="w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-semibold shrink-0 text-white bg-emerald-500">
        AI
      </div>
      <div className="px-3.5 py-3 rounded-xl bg-muted flex items-center gap-[5px]">
        <span className="block w-[7px] h-[7px] rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
        <span className="block w-[7px] h-[7px] rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:160ms]" />
        <span className="block w-[7px] h-[7px] rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:320ms]" />
      </div>
    </div>
  );
}

export function StreamingArea({
  messages,
  streamingDelta,
  showMemoryIndicator,
  onFeedback,
  thinking = false,
}: {
  messages: ChatMessage[];
  streamingDelta: string | null;
  showMemoryIndicator: boolean;
  onFeedback?: (id: string, score: -1 | 1) => void;
  thinking?: boolean;
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
    // Force scroll when the user just sent (last msg is theirs) or while the
    // AI is thinking — so the ellipsis bubble and eventual response are visible
    // even if the user had scrolled up in a long conversation.
    const lastMsgIsFromUser = messages[messages.length - 1]?.role === "user";
    if (atBottom || lastMsgIsFromUser || thinking) {
      sentinelRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages, streamingDelta, atBottom, thinking]);

  function scrollToLatest(): void {
    sentinelRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto p-4 relative">
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
      {/* Thinking bubble shows while a turn is in flight and no assistant text is
          visible yet — buffer is null before the first token AND "" after a
          delta_start/rewriting reset. Gating on `=== null` alone left the long
          pre-first-token wait blank, since send() seeds the buffer with "". */}
      {thinking && (streamingDelta === null || streamingDelta.length === 0) && <ThinkingBubble />}
      <div ref={sentinelRef} aria-hidden="true" />
      {!atBottom && (
        <button
          type="button"
          onClick={scrollToLatest}
          className="sticky bottom-3 float-right bg-primary text-primary-foreground border-none px-3.5 py-2 rounded-[20px] cursor-pointer text-sm"
        >
          New message ↓
        </button>
      )}
    </div>
  );
}
