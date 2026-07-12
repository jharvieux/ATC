"use client";

// Agent-console redesign (#902 PR B + spec: agent-console-redesign-instructions.md).
// Four structural changes from the original flat layout:
//   1. Single merged sidebar (Chats / Memory / Prefs segmented control).
//   2. Inline "Draft a reply" tab — no navigation away from this screen.
//   3. Rich agent picker chip with bio, tags, and search popover.
//   4. Token-driven dark/light theme via [data-ta-theme] CSS custom properties.
//
// Backend/chat logic is unchanged — all API calls and SSE handling live in
// ChatExperience; this component only controls layout, agent selection, and theme.
//
// #1781/#1791 — this file used to be 925 lines: a 14-useState god component
// plus 4 sub-components (ConvGroup/ChatsPanel/TaMemoryPanel/TaPrefsPanel)
// defined inline. The sub-components now live in their own files, and the
// conversation/persona state lives in useConciergeConversations — this
// component keeps only its own layout-local UI state (rail/tab/search).

import { useState } from "react";
import { PanelLeft, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChatExperience } from "@/components/chat/ChatExperience";
import { useTaThemeSync, ICON_BTN_STYLE } from "@/lib/ta-theme/use-ta-theme";
import { useConciergeConversations } from "@/lib/concierge/use-concierge-conversations";
import { AgentPickerPopover } from "./AgentPickerPopover";
import { InlineDraftView } from "./InlineDraftView";
import { ChatsPanel } from "./ChatsPanel";
import { TaMemoryPanel } from "./TaMemoryPanel";
import { TaPrefsPanel } from "./TaPrefsPanel";

type SidebarTab = "chats" | "memory" | "prefs";
type MainTab = "conversation" | "draft";

export function ConciergeExperience(): React.JSX.Element {
  // Theme sync — TenantShell owns the toggle button; this component only
  // needs to react to theme changes and ensure data-ta-theme is applied on
  // mount so --ta-* CSS vars resolve for this subtree.
  useTaThemeSync();

  // Local rail open/close. Tri-state: null = CSS default (closed below lg, open on lg+).
  const [railOpen, setRailOpen] = useState<boolean | null>(null);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("chats");
  const [mainTab, setMainTab] = useState<MainTab>("conversation");
  const [showQualityPill, setShowQualityPill] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  const {
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
  } = useConciergeConversations();

  // ─── Error / access states ────────────────────────────────────────────────

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

  // ─── Layout helpers ───────────────────────────────────────────────────────

  const sidebarWidth = railOpen === null ? "w-0 lg:w-[300px]" : railOpen ? "w-[300px]" : "w-0";

  const tabBtn = (active: boolean): React.CSSProperties => ({
    padding: "9px 14px",
    border: "none",
    borderBottom: active ? "2px solid var(--ta-accent)" : "2px solid transparent",
    background: "transparent",
    fontSize: 13,
    fontWeight: active ? 600 : 400,
    color: active ? "var(--ta-accent)" : "var(--ta-text-mute)",
    cursor: "pointer",
    transition: "color 0.12s, border-color 0.12s",
    whiteSpace: "nowrap" as const,
  });

  const sidebarTabBtn = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "8px 0",
    border: "none",
    borderBottom: active ? "2px solid var(--ta-accent)" : "2px solid transparent",
    background: "transparent",
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.7,
    textTransform: "uppercase" as const,
    color: active ? "var(--ta-accent)" : "var(--ta-text-mute)",
    cursor: "pointer",
    transition: "color 0.12s, border-color 0.12s",
  });

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      className="flex flex-col h-full overflow-hidden"
      style={{ background: "var(--ta-bg)", color: "var(--ta-text)" }}
    >

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Sidebar ─────────────────────────────────────────────────── */}
        <aside
          className={cn("shrink-0 overflow-hidden transition-all duration-200", sidebarWidth)}
          style={{
            borderRight: "1px solid var(--ta-border)",
            background: "var(--ta-sidebar)",
          }}
        >
          {/* Fixed inner width so content doesn't reflow during animation */}
          <div className="flex flex-col h-full" style={{ width: 300 }}>

            {/* Rail toggle + New chat button */}
            <div style={{ padding: "12px 12px 8px", display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                aria-label="Toggle conversation rail"
                onClick={() =>
                  setRailOpen((prev) =>
                    prev === null ? !window.matchMedia("(min-width: 1024px)").matches : !prev,
                  )
                }
                style={{ ...ICON_BTN_STYLE, color: "var(--ta-text-soft)", flexShrink: 0 }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "var(--ta-hover)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                }}
              >
                <PanelLeft size={16} />
              </button>
              <button
                type="button"
                onClick={startNew}
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  padding: "8px 12px",
                  borderRadius: "var(--ta-r-sm, 9px)",
                  border: "none",
                  background: "var(--ta-accent)",
                  color: "var(--ta-accent-ink)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "opacity 0.12s",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.opacity = "0.88";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.opacity = "1";
                }}
              >
                <Plus size={14} />
                New chat
              </button>
            </div>

            {/* Search */}
            <div style={{ padding: "0 12px 6px" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  background: "var(--ta-surface-2)",
                  border: "1px solid var(--ta-border)",
                  borderRadius: 7,
                  padding: "5px 9px",
                }}
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="6.5" cy="6.5" r="5" stroke="var(--ta-text-mute)" strokeWidth="1.5" />
                  <path d="M10.5 10.5L14 14" stroke="var(--ta-text-mute)" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <input
                  type="text"
                  placeholder="Search chats…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{
                    flex: 1,
                    border: "none",
                    background: "transparent",
                    fontSize: 12,
                    color: "var(--ta-text)",
                    outline: "none",
                  }}
                />
              </div>
            </div>

            {/* Chats · Memory · Prefs segmented tabs */}
            <div
              style={{
                display: "flex",
                padding: "0 12px",
                borderBottom: "1px solid var(--ta-border)",
              }}
            >
              {(["chats", "memory", "prefs"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setSidebarTab(tab)}
                  style={sidebarTabBtn(sidebarTab === tab)}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>

            {/* Panel content */}
            <div
              className="flex-1 overflow-y-auto"
              style={{ padding: "10px 12px" }}
            >
              {sidebarTab === "chats" && (
                <ChatsPanel
                  conversations={conversations}
                  activeConvId={activeConvId}
                  loadingConv={loadingConv}
                  searchQuery={searchQuery}
                  onOpen={(id) => void openConversation(id)}
                />
              )}
              {sidebarTab === "memory" && <TaMemoryPanel />}
              {sidebarTab === "prefs" && (
                <TaPrefsPanel
                  showQualityPill={showQualityPill}
                  onToggleQualityPill={setShowQualityPill}
                />
              )}
            </div>
          </div>
        </aside>

        {/* ── Main panel ──────────────────────────────────────────────── */}
        <div
          className="flex flex-col flex-1 overflow-hidden"
          style={{ background: "var(--ta-bg)" }}
        >
          {/* Main header — agent chip + status pills */}
          <div
            style={{
              padding: "10px 16px",
              borderBottom: "1px solid var(--ta-border)",
              background: "var(--ta-surface)",
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexShrink: 0,
              flexWrap: "wrap",
            }}
          >
            <AgentPickerPopover
              selectedSlug={selectedPersona}
              onSelect={selectPersona}
            />
            <div style={{ flex: 1 }} />
            {/* TA mode pill */}
            <span
              style={{
                fontSize: 10,
                padding: "3px 9px",
                background: "var(--ta-accent-soft)",
                color: "var(--ta-accent)",
                borderRadius: 20,
                fontWeight: 700,
                letterSpacing: 0.5,
                textTransform: "uppercase",
              }}
            >
              TA mode
            </span>
            {/* Quality review pill — toggled by Prefs */}
            {showQualityPill && (
              <span
                title="Conversations are reviewed for quality"
                style={{
                  fontSize: 10,
                  padding: "3px 9px",
                  background: "rgba(240,180,90,.12)",
                  color: "var(--ta-amber)",
                  borderRadius: 20,
                  fontWeight: 600,
                  letterSpacing: 0.3,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                🛡 Reviewed for quality
              </span>
            )}
          </div>

          {/* Tab row — Conversation | Draft a reply */}
          <div
            style={{
              display: "flex",
              borderBottom: "1px solid var(--ta-border)",
              background: "var(--ta-surface)",
              padding: "0 16px",
              flexShrink: 0,
            }}
          >
            <button
              type="button"
              onClick={() => setMainTab("conversation")}
              style={tabBtn(mainTab === "conversation")}
            >
              Conversation
            </button>
            <button
              type="button"
              onClick={() => setMainTab("draft")}
              style={tabBtn(mainTab === "draft")}
            >
              Draft a reply
              <span
                style={{
                  marginLeft: 5,
                  fontSize: 9,
                  padding: "1px 5px",
                  background: "var(--ta-accent-soft)",
                  color: "var(--ta-accent)",
                  borderRadius: 3,
                  fontWeight: 700,
                  letterSpacing: 0.4,
                }}
              >
                AI
              </span>
            </button>
          </div>

          {/* Conv-load error */}
          {convLoadError && (
            <p
              style={{
                fontSize: 12,
                color: "#F87171",
                padding: "6px 16px",
                borderBottom: "1px solid var(--ta-border)",
                margin: 0,
              }}
            >
              {convLoadError}
            </p>
          )}

          {/* Active tab content */}
          <div className="flex-1 overflow-hidden">
            {mainTab === "conversation" ? (
              <ChatExperience
                key={chatKey}
                mode="ta"
                personaSlug={selectedPersona}
                initialConversationId={activeConvId ?? undefined}
                initialMessages={activeMessages}
                onConversationCreated={handleConversationCreated}
                hideSidebar
                hideBanner
                composerPlaceholder={`Ask ${selectedAgent.name} about trade topics…`}
                composerHelper={`${selectedAgent.name} is an AI specialist · Trade-mode answers, no customer guardrails`}
              />
            ) : (
              <div className="flex h-full overflow-hidden">
                <InlineDraftView agentSlug={selectedPersona} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
