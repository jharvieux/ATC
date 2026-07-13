"use client";

// #1781/#1791 — extracted from ConciergeExperience.tsx (was a 925-line file
// with 4 sub-components defined inline). Renders the "Chats" sidebar tab:
// search-filtered conversation list, grouped into Today / Earlier.

import { ConvGroup } from "./ConvGroup";
import type { TaConversation } from "@/lib/concierge/use-concierge-conversations";

export function ChatsPanel({
  conversations,
  activeConvId,
  loadingConv,
  searchQuery,
  onOpen,
}: {
  conversations: TaConversation[] | null;
  activeConvId: string | null;
  loadingConv: boolean;
  searchQuery: string;
  onOpen: (id: string) => void;
}): React.JSX.Element {
  if (conversations === null) {
    return <p style={{ fontSize: 12, color: "var(--ta-text-mute)" }}>Loading…</p>;
  }

  const filtered = conversations.filter((c) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (c.title ?? "").toLowerCase().includes(q);
  });

  if (filtered.length === 0) {
    return (
      <p style={{ fontSize: 12, color: "var(--ta-text-mute)" }}>
        {searchQuery ? `No chats matching "${searchQuery}"` : "No chats yet."}
      </p>
    );
  }

  const today = new Date().toDateString();
  const todayList = filtered.filter(
    (c) => c.last_message_at && new Date(c.last_message_at).toDateString() === today,
  );
  const earlierList = filtered.filter(
    (c) => !c.last_message_at || new Date(c.last_message_at).toDateString() !== today,
  );

  return (
    <>
      <ConvGroup
        label="Today"
        items={todayList}
        activeConvId={activeConvId}
        loadingConv={loadingConv}
        onOpen={onOpen}
      />
      <ConvGroup
        label="Earlier"
        items={earlierList}
        activeConvId={activeConvId}
        loadingConv={loadingConv}
        onOpen={onOpen}
      />
    </>
  );
}
