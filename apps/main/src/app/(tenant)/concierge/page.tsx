"use client";

// #902 PR B — TA-mode dashboard chat surface.
//
// Travel agents (tenant_owner/agent role) use this page to:
//   1. Get cruise-domain expertise from any of the six personas.
//   2. Ask platform how-to questions (grounded in help docs via PR A).
//
// Access is enforced server-side on every API call (403 → access-denied
// UX here). Viewer-role users (customers) land on the access-denied state.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatExperience } from "@/components/chat/ChatExperience";
import type { ChatMessage } from "@/components/chat/MessageBubble";
import { AGENT_CATALOG } from "@/lib/agents/catalog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface TaConversation {
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

export default function ConciergePage(): React.JSX.Element {
  const [conversations, setConversations] = useState<TaConversation[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Active chat state
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [activeMessages, setActiveMessages] = useState<ChatMessage[]>([]);
  const [selectedPersona, setSelectedPersona] = useState<string>(AGENT_CATALOG[0]!.slug);
  const [loadingConv, setLoadingConv] = useState(false);

  // chatKey forces ChatExperience to remount (reset state) when switching
  // conversations or starting fresh.
  const chatKey = useRef(0);
  const [chatKeyState, setChatKeyState] = useState(0);

  const fetchConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/ta-conversations");
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) {
        setLoadError(`Could not load conversations (HTTP ${res.status})`);
        return;
      }
      const data = (await res.json()) as { conversations: TaConversation[] };
      setConversations(data.conversations ?? []);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void fetchConversations();
  }, [fetchConversations]);

  async function openConversation(convId: string): Promise<void> {
    setLoadingConv(true);
    try {
      const res = await fetch(`/api/chat/conversations/${convId}`);
      if (!res.ok) return;
      const data = (await res.json()) as ConvMessages;
      const persona = data.conversation.active_persona_id ?? selectedPersona;
      setActiveConvId(convId);
      setActiveMessages(data.messages ?? []);
      setSelectedPersona(persona);
      chatKey.current += 1;
      setChatKeyState(chatKey.current);
    } finally {
      setLoadingConv(false);
    }
  }

  function startNew(): void {
    setActiveConvId(null);
    setActiveMessages([]);
    chatKey.current += 1;
    setChatKeyState(chatKey.current);
    // Refresh the conversation list after a short delay so a just-created
    // conversation shows up (it's created on the first message send).
    setTimeout(() => { void fetchConversations(); }, 2000);
  }

  if (forbidden) {
    return (
      <div className="p-8 max-w-lg mx-auto text-center mt-16">
        <h1 className="text-xl font-semibold mb-2">Access restricted</h1>
        <p className="text-muted-foreground text-sm">
          The Concierge is available to team members (Owner or Agent role). Contact
          your workspace owner to update your access level.
        </p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="p-8 max-w-lg mx-auto text-center mt-16">
        <p className="text-red-700 dark:text-red-400 text-sm">{loadError}</p>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 border-r border-border flex flex-col bg-card">
        <div className="px-3 py-3 border-b border-border">
          <h2 className="text-[13px] font-semibold text-foreground mb-2">Concierge</h2>
          <Button
            variant="outline"
            className="w-full text-[12px] h-7"
            onClick={startNew}
          >
            + New chat
          </Button>
        </div>

        <nav className="flex-1 overflow-y-auto py-2 px-2">
          {conversations === null ? (
            <p className="text-[12px] text-muted-foreground px-1">Loading…</p>
          ) : conversations.length === 0 ? (
            <p className="text-[12px] text-muted-foreground px-1">No chats yet.</p>
          ) : (
            conversations.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => void openConversation(c.id)}
                disabled={loadingConv}
                className={`w-full text-left px-2 py-1.5 rounded text-[12px] mb-0.5 hover:bg-accent transition-colors truncate ${
                  activeConvId === c.id
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground"
                }`}
              >
                {c.title ?? "(untitled)"}
                <span className="block text-[10px] opacity-60">
                  {c.message_count ?? 0} msgs ·{" "}
                  {c.last_message_at
                    ? new Date(c.last_message_at).toLocaleDateString()
                    : "—"}
                </span>
              </button>
            ))
          )}
        </nav>
      </aside>

      {/* Main area */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Persona picker */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-card shrink-0">
          <span className="text-[12px] text-muted-foreground whitespace-nowrap">
            Speaking with
          </span>
          <Select
            value={selectedPersona}
            onValueChange={(v) => {
              setSelectedPersona(v);
              // Start a fresh conversation when the persona changes so the
              // new persona's Layer-1 identity is applied from the first turn.
              setActiveConvId(null);
              setActiveMessages([]);
              chatKey.current += 1;
              setChatKeyState(chatKey.current);
            }}
          >
            <SelectTrigger className="h-7 text-[12px] w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AGENT_CATALOG.map((a) => (
                <SelectItem key={a.slug} value={a.slug} className="text-[12px]">
                  {a.name} · {a.specialty}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-[11px] text-muted-foreground hidden sm:block">
            TA mode — trade topics, platform questions, no customer guardrails
          </span>
        </div>

        {/* Chat */}
        <div className="flex-1 overflow-hidden">
          <ChatExperience
            key={chatKeyState}
            mode="ta"
            personaSlug={selectedPersona}
            initialConversationId={activeConvId ?? undefined}
            initialMessages={activeMessages}
          />
        </div>
      </div>
    </div>
  );
}
