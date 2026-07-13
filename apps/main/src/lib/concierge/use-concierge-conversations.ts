// #1781/#1791 — extracted from ConciergeExperience.tsx, which owned 14
// useState hooks in one component (a re-render + maintainability liability).
// This hook owns everything related to the TA conversation list + the
// currently active conversation/persona; the caller keeps only its own
// layout-local UI state (rail/tab/search).

import { useCallback, useEffect, useState } from "react";
import type { ChatMessage } from "@/components/chat/MessageBubble";
import { AGENT_CATALOG } from "@/lib/agents/catalog";

export interface TaConversation {
  id: string;
  title: string | null;
  last_message_at: string | null;
  message_count: number | null;
  active_persona_id: string | null;
}

interface ConvMessages {
  conversation: { active_persona_id: string | null };
  messages: ChatMessage[];
}

export function useConciergeConversations() {
  const [conversations, setConversations] = useState<TaConversation[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [activeMessages, setActiveMessages] = useState<ChatMessage[]>([]);
  const [selectedPersona, setSelectedPersona] = useState<string>(AGENT_CATALOG[0]!.slug);
  const [convLoadError, setConvLoadError] = useState<string | null>(null);
  const [loadingConv, setLoadingConv] = useState(false);
  const [chatKey, setChatKey] = useState(0);

  const selectedAgent =
    AGENT_CATALOG.find((a) => a.slug === selectedPersona) ?? AGENT_CATALOG[0]!;

  const fetchConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/ta-conversations");
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) { setLoadError(`Could not load conversations (HTTP ${res.status})`); return; }
      const data = (await res.json()) as { conversations: TaConversation[] };
      setConversations(data.conversations ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void fetchConversations(); }, [fetchConversations]);

  async function openConversation(convId: string): Promise<void> {
    setConvLoadError(null);
    setLoadingConv(true);
    try {
      const res = await fetch(`/api/chat/conversations/${convId}`);
      if (!res.ok) { setConvLoadError(`Could not load conversation (HTTP ${res.status})`); return; }
      const data = (await res.json()) as ConvMessages;
      const persona = data.conversation.active_persona_id ?? selectedPersona;
      setActiveConvId(convId);
      setActiveMessages(data.messages ?? []);
      setSelectedPersona(persona);
      setChatKey((k) => k + 1);
    } finally {
      setLoadingConv(false);
    }
  }

  function startNew(): void {
    setActiveConvId(null);
    setActiveMessages([]);
    setConvLoadError(null);
    setChatKey((k) => k + 1);
  }

  const handleConversationCreated = useCallback(
    (_id: string) => { void fetchConversations(); },
    [fetchConversations],
  );

  function selectPersona(slug: string): void {
    setSelectedPersona(slug);
    setActiveConvId(null);
    setActiveMessages([]);
    setChatKey((k) => k + 1);
  }

  return {
    conversations,
    forbidden,
    loadError,
    activeConvId,
    activeMessages,
    selectedPersona,
    selectedAgent,
    convLoadError,
    loadingConv,
    chatKey,
    openConversation,
    startNew,
    handleConversationCreated,
    selectPersona,
  };
}
