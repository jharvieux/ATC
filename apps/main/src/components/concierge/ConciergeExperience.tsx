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

import { useCallback, useEffect, useState } from "react";
import { PanelLeft, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChatExperience } from "@/components/chat/ChatExperience";
import type { ChatMessage } from "@/components/chat/MessageBubble";
import { AGENT_CATALOG } from "@/lib/agents/catalog";
import { useTaThemeSync, ICON_BTN_STYLE } from "@/lib/ta-theme/use-ta-theme";
import { AgentPickerPopover } from "./AgentPickerPopover";
import { InlineDraftView } from "./InlineDraftView";
import { TONE_LABELS } from "@/lib/tone/constants";

// ─── Types ──────────────────────────────────────────────────────────────────

type SidebarTab = "chats" | "memory" | "prefs";
type MainTab = "conversation" | "draft";

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

// ─── Sidebar sub-panels ──────────────────────────────────────────────────────

function ConvGroup({
  label,
  items,
  activeConvId,
  loadingConv,
  onOpen,
}: {
  label: string;
  items: TaConversation[];
  activeConvId: string | null;
  loadingConv: boolean;
  onOpen: (id: string) => void;
}): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div style={{ marginBottom: 8 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.7,
          textTransform: "uppercase",
          color: "var(--ta-text-mute)",
          padding: "4px 2px",
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      {items.map((c) => {
        const isActive = c.id === activeConvId;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onOpen(c.id)}
            disabled={loadingConv}
            style={{
              width: "100%",
              textAlign: "left",
              padding: "6px 8px",
              borderRadius: 7,
              marginBottom: 1,
              border: isActive ? "1px solid var(--ta-border-2)" : "1px solid transparent",
              background: isActive ? "var(--ta-surface-2)" : "transparent",
              cursor: loadingConv ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "flex-start",
              gap: 6,
            }}
            onMouseEnter={(e) => {
              if (!isActive)
                (e.currentTarget as HTMLButtonElement).style.background = "var(--ta-hover)";
            }}
            onMouseLeave={(e) => {
              if (!isActive)
                (e.currentTarget as HTMLButtonElement).style.background = "transparent";
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: isActive ? "var(--ta-accent)" : "var(--ta-border-2)",
                flexShrink: 0,
                marginTop: 5,
              }}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 12,
                  color: isActive ? "var(--ta-text)" : "var(--ta-text-soft)",
                  fontWeight: isActive ? 600 : 400,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontStyle: c.title ? "normal" : "italic",
                }}
              >
                {c.title ?? "Untitled"}
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: "var(--ta-text-mute)",
                  fontFamily: "var(--font-geist-mono, monospace)",
                  marginTop: 1,
                }}
              >
                {c.message_count ?? 0} msgs ·{" "}
                {c.last_message_at ? new Date(c.last_message_at).toLocaleDateString() : "—"}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function ChatsPanel({
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

// ─── Memory panel ────────────────────────────────────────────────────────────

interface MemoryRow {
  preferences?: Record<string, unknown> | null;
  travel_history?: Record<string, unknown> | null;
  family_composition?: unknown[] | null;
  accessibility_needs?: Record<string, unknown> | null;
  dietary_restrictions?: Record<string, unknown> | null;
  loyalty_programs?: unknown[] | null;
  important_dates?: Record<string, unknown> | null;
  notes_freeform?: string | null;
}

const MEMORY_ICONS: Record<string, string> = {
  preferences: "⚙️",
  travel_history: "🗺️",
  family_composition: "👨‍👩‍👧",
  accessibility_needs: "♿",
  dietary_restrictions: "🍽️",
  loyalty_programs: "🎖️",
  important_dates: "📅",
  notes_freeform: "📝",
};

const MEMORY_LABELS: Record<string, string> = {
  preferences: "Preferences",
  travel_history: "Travel history",
  family_composition: "Family",
  accessibility_needs: "Accessibility",
  dietary_restrictions: "Dietary",
  loyalty_programs: "Loyalty",
  important_dates: "Dates",
  notes_freeform: "Notes",
};

function TaMemoryPanel(): React.JSX.Element {
  const [mem, setMem] = useState<MemoryRow | null | "loading">("loading");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/memory");
        if (!r.ok) { setErr(`HTTP ${r.status}`); return; }
        const data = (await r.json()) as MemoryRow | null;
        setMem(data ?? null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  if (err) {
    return (
      <p style={{ fontSize: 12, color: "#F87171" }}>Could not load memory: {err}</p>
    );
  }
  if (mem === "loading") {
    return <p style={{ fontSize: 12, color: "var(--ta-text-mute)" }}>Loading…</p>;
  }
  if (!mem) {
    return (
      <p style={{ fontSize: 12, color: "var(--ta-text-mute)" }}>
        No client memory yet — keep chatting and it will appear here.
      </p>
    );
  }

  const entries = Object.entries(mem).filter(([, v]) => {
    if (v === null || v === undefined) return false;
    if (Array.isArray(v) && v.length === 0) return false;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) return false;
    return true;
  });

  if (entries.length === 0) {
    return (
      <p style={{ fontSize: 12, color: "var(--ta-text-mute)" }}>
        No client memory yet — keep chatting and it will appear here.
      </p>
    );
  }

  return (
    <div>
      {entries.map(([key, val]) => (
        <div
          key={key}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: "7px 8px",
            borderRadius: 7,
            marginBottom: 3,
            background: "var(--ta-surface-2)",
            border: "1px solid var(--ta-border)",
          }}
        >
          <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>
            {MEMORY_ICONS[key] ?? "💡"}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.5,
                textTransform: "uppercase",
                color: "var(--ta-text-mute)",
                marginBottom: 2,
              }}
            >
              {MEMORY_LABELS[key] ?? key}
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--ta-text-soft)",
                fontFamily: "var(--font-geist-mono, monospace)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {typeof val === "string"
                ? val
                : JSON.stringify(val, null, 2)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Prefs panel ─────────────────────────────────────────────────────────────

function TaPrefsPanel({
  showQualityPill,
  onToggleQualityPill,
}: {
  showQualityPill: boolean;
  onToggleQualityPill: (v: boolean) => void;
}): React.JSX.Element {
  const [tone, setTone] = useState<number>(3);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/memory");
        if (!r.ok) return;
        const data = (await r.json()) as { rapport_tone_level?: number | null } | null;
        setTone(data?.rapport_tone_level ?? 3);
      } catch {
        // network failure — leave the default tone in place
      }
    })();
  }, []);

  async function save(): Promise<void> {
    setSaving(true);
    setStatus(null);
    try {
      const r = await fetch("/api/memory", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rapport_tone_level: tone }),
      });
      setStatus(r.ok ? "Saved." : "Couldn't save.");
    } catch {
      setStatus("Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 0",
    borderBottom: "1px solid var(--ta-border)",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    color: "var(--ta-text-soft)",
  };
  return (
    <div>
      <div style={rowStyle}>
        <span style={labelStyle}>Default agent</span>
        <span style={{ fontSize: 11, color: "var(--ta-text-mute)" }}>Set via agent picker</span>
      </div>
      <div style={{ padding: "8px 0", borderBottom: "1px solid var(--ta-border)" }}>
        <span style={labelStyle}>Reply tone</span>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 6 }}>
          {TONE_LABELS.map((label, i) => {
            const level = i + 1;
            return (
              <button
                key={label}
                type="button"
                onClick={() => setTone(level)}
                style={{
                  padding: "3px 10px",
                  borderRadius: 20,
                  fontSize: 11,
                  fontWeight: 500,
                  cursor: "pointer",
                  border: `1px solid ${tone === level ? "var(--ta-accent)" : "var(--ta-border-2)"}`,
                  background: tone === level ? "var(--ta-accent-soft)" : "transparent",
                  color: tone === level ? "var(--ta-accent)" : "var(--ta-text-soft)",
                  transition: "all 0.12s",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        {tone === 5 && (
          <p style={{ fontSize: 11, color: "var(--ta-amber, #f59e0b)", margin: "6px 0 0" }}>
            ⚠ Profanity is permitted at this tone level.
          </p>
        )}
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Quality-review notice</span>
        <button
          type="button"
          role="switch"
          aria-checked={showQualityPill}
          onClick={() => onToggleQualityPill(!showQualityPill)}
          style={{
            width: 36,
            height: 20,
            borderRadius: 10,
            border: "none",
            background: showQualityPill ? "var(--ta-accent)" : "var(--ta-border-2)",
            cursor: "pointer",
            position: "relative",
            transition: "background 0.2s",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 2,
              left: showQualityPill ? 18 : 2,
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: "#fff",
              transition: "left 0.2s",
            }}
          />
        </button>
      </div>
      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        style={{
          marginTop: 14,
          padding: "6px 16px",
          borderRadius: 7,
          fontSize: 12,
          fontWeight: 500,
          cursor: saving ? "not-allowed" : "pointer",
          border: "none",
          background: saving ? "var(--ta-surface-2)" : "var(--ta-accent)",
          color: saving ? "var(--ta-text-mute)" : "var(--ta-accent-ink)",
          transition: "background 0.15s",
        }}
      >
        {saving ? "Saving…" : "Save preferences"}
      </button>
      {status && (
        <p
          style={{
            fontSize: 11,
            marginTop: 6,
            color: status === "Saved." ? "var(--ta-green)" : "#F87171",
          }}
        >
          {status}
        </p>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

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

  // ─── Data fetching ────────────────────────────────────────────────────────

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
              onSelect={(slug) => {
                setSelectedPersona(slug);
                setActiveConvId(null);
                setActiveMessages([]);
                setChatKey((k) => k + 1);
              }}
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
