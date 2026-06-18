"use client";

// #1200 — Conversation history rail for CRM pages. Staff (tenant_owner/agent)
// get a PanelLeft toggle that slides in an overlay panel showing recent
// conversations. Clicking a conversation navigates to /concierge so the user
// can continue chatting without going back to / first.
//
// Rendered inside the SiteHeader's leftSlot so it visually matches the
// TenantShell toggle at /. The panel is fixed-position so it overlays the
// CRM content rather than displacing it.

import * as React from "react";
import Link from "next/link";
import { PanelLeft, X, MessageSquare, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface TaConversation {
  id: string;
  title: string | null;
  last_message_at: string | null;
  message_count: number | null;
}

export function ConversationRailDrawer(): React.JSX.Element {
  const [isOpen, setIsOpen] = React.useState(false);
  const [conversations, setConversations] = React.useState<TaConversation[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  // Fetch on first open only.
  const hasFetched = React.useRef(false);

  React.useEffect(() => {
    if (!isOpen || hasFetched.current) return;
    hasFetched.current = true;

    void (async () => {
      try {
        const res = await fetch("/api/chat/ta-conversations");
        if (!res.ok) {
          setLoadError(`Could not load conversations (HTTP ${res.status})`);
          return;
        }
        const data = (await res.json()) as { conversations: TaConversation[] };
        setConversations(data.conversations ?? []);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [isOpen]);

  // Close on Escape.
  React.useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setIsOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen]);

  return (
    <>
      {/* Toggle button — sits in the SiteHeader leftSlot */}
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        aria-label="Toggle conversation history"
        aria-expanded={isOpen}
        className="rounded-md p-1.5 hover:bg-accent"
      >
        <PanelLeft className="h-5 w-5" />
      </button>

      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/20"
          aria-hidden="true"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Slide-in panel */}
      <div
        className={cn(
          "fixed left-0 top-0 z-50 flex h-full w-72 flex-col border-r border-border bg-card shadow-xl transition-transform duration-200",
          isOpen ? "translate-x-0" : "-translate-x-full",
        )}
        aria-label="Conversation history"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-3">
          <span className="text-sm font-semibold text-foreground">Conversations</span>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            aria-label="Close conversation history"
            className="rounded-md p-1 hover:bg-accent"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-3 py-2 border-b border-border">
          <Button asChild variant="outline" className="h-8 w-full gap-2 text-xs">
            <Link href="/concierge" onClick={() => setIsOpen(false)}>
              <Plus className="h-4 w-4" />
              New chat
            </Link>
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {loadError && (
            <p className="px-3 py-4 text-center text-xs text-destructive">{loadError}</p>
          )}

          {!loadError && conversations === null && (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">Loading…</p>
          )}

          {conversations !== null && conversations.length === 0 && (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">No conversations yet.</p>
          )}

          {conversations !== null && conversations.map((conv) => (
            <Link
              key={conv.id}
              href={`/concierge?c=${conv.id}`}
              onClick={() => setIsOpen(false)}
              className="flex items-start gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent"
            >
              <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">
                  {conv.title ?? "Untitled conversation"}
                </p>
                {conv.last_message_at && (
                  <p className="text-xs text-muted-foreground">
                    {new Date(conv.last_message_at).toLocaleDateString()}
                  </p>
                )}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
