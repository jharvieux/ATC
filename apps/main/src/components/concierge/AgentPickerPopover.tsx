"use client";

// Agent-console redesign — rich agent picker chip + popover.
// Shows bio, expertise tags, and "Best for:" so the TA can pick the right
// specialist without leaving the conversation view.

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { AGENT_CATALOG, type AgentCatalogEntry } from "@/lib/agents/catalog";

// Stable per-slug gradient so avatars look distinct even when the image fails.
const AVATAR_GRADIENTS: Record<string, string> = {
  "marcus-cole": "linear-gradient(135deg,#1E6FA8,#5DADE2)",
  "marco-bellini": "linear-gradient(135deg,#2E7D52,#52C888)",
  "priya-sharma": "linear-gradient(135deg,#6B3FA0,#B07DE0)",
  "captain-dave": "linear-gradient(135deg,#B05A2E,#E0914D)",
  "maya-patel": "linear-gradient(135deg,#2E7DA0,#4DBBE0)",
  "jenny-hartwell": "linear-gradient(135deg,#A02E6B,#E04DA5)",
};

export function AgentAvatar({
  agent,
  size = 32,
}: {
  agent: AgentCatalogEntry;
  size?: number;
}): React.JSX.Element {
  const [imgFailed, setImgFailed] = useState(false);
  const grad = AVATAR_GRADIENTS[agent.slug] ?? "linear-gradient(135deg,#5DADE2,#1E6FA8)";

  if (imgFailed) {
    return (
      <span
        aria-label={agent.name}
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: grad,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: Math.round(size * 0.375),
          fontWeight: 600,
          color: "#fff",
          flexShrink: 0,
          userSelect: "none",
        }}
      >
        {agent.name.split(" ").map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase()}
      </span>
    );
  }

  return (
    <Image
      src={agent.image}
      alt={agent.name}
      width={size}
      height={size}
      style={{ borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
      onError={() => setImgFailed(true)}
    />
  );
}

interface AgentPickerPopoverProps {
  selectedSlug: string;
  onSelect: (slug: string) => void;
}

export function AgentPickerPopover({
  selectedSlug,
  onSelect,
}: AgentPickerPopoverProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = AGENT_CATALOG.find((a) => a.slug === selectedSlug) ?? AGENT_CATALOG[0]!;

  const filtered = AGENT_CATALOG.filter((a) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      a.name.toLowerCase().includes(q) ||
      a.specialty.toLowerCase().includes(q) ||
      a.quizTags.some((t) => t.includes(q)) ||
      a.bio.some((b) => b.toLowerCase().includes(q))
    );
  });

  // Close on outside-click or Esc.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Auto-focus search when popover opens.
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => searchRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      {/* Chip */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Select agent"
        aria-expanded={open}
        aria-haspopup="listbox"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 12px 5px 8px",
          background: open ? "var(--ta-accent-soft)" : "var(--ta-surface)",
          border: `1px solid ${open ? "var(--ta-accent)" : "var(--ta-border-2)"}`,
          borderRadius: "var(--ta-r)",
          cursor: "pointer",
          transition: "border-color 0.15s, background 0.15s",
          outline: open ? "2px solid var(--ta-accent-soft)" : "none",
          outlineOffset: 2,
        }}
      >
        <AgentAvatar agent={selected} size={28} />
        <div style={{ textAlign: "left", lineHeight: 1 }}>
          <div
            style={{
              fontSize: 9,
              color: "var(--ta-text-mute)",
              fontWeight: 600,
              letterSpacing: 0.7,
              textTransform: "uppercase",
              marginBottom: 3,
            }}
          >
            Speaking with
          </div>
          <div style={{ fontSize: 13, color: "var(--ta-text)", fontWeight: 600 }}>
            {selected.name}
            <span
              style={{ fontSize: 11, fontWeight: 400, color: "var(--ta-text-soft)", marginLeft: 5 }}
            >
              · {selected.specialty}
            </span>
          </div>
        </div>
        <ChevronDown
          size={13}
          color="var(--ta-text-mute)"
          style={{
            marginLeft: 4,
            flexShrink: 0,
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.15s",
          }}
        />
      </button>

      {/* Backdrop + Popover */}
      {open && (
        <>
          <div
            aria-hidden="true"
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 40 }}
          />
          <div
            role="listbox"
            aria-label="Select a specialist"
            style={{
              position: "absolute",
              top: "calc(100% + 8px)",
              left: 0,
              zIndex: 50,
              width: 420,
              maxHeight: 500,
              background: "var(--ta-elevated)",
              border: "1px solid var(--ta-border-2)",
              borderRadius: "var(--ta-r-lg, 18px)",
              boxShadow: "0 8px 32px rgba(0,0,0,.28)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {/* Search bar */}
            <div
              style={{
                padding: "10px 12px",
                borderBottom: "1px solid var(--ta-border)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: "var(--ta-surface-2)",
                  borderRadius: "var(--ta-r-sm, 9px)",
                  padding: "6px 10px",
                }}
              >
                <Search size={12} color="var(--ta-text-mute)" style={{ flexShrink: 0 }} />
                <input
                  ref={searchRef}
                  type="text"
                  placeholder="Search by name, region, or specialty…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={{
                    flex: 1,
                    border: "none",
                    background: "transparent",
                    fontSize: 12,
                    color: "var(--ta-text)",
                    outline: "none",
                  }}
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="Clear search"
                    style={{
                      border: "none",
                      background: "none",
                      cursor: "pointer",
                      color: "var(--ta-text-mute)",
                      padding: 0,
                      lineHeight: 1,
                      display: "flex",
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            </div>

            {/* Agent rows */}
            <div style={{ overflowY: "auto", flex: 1 }}>
              {filtered.map((agent, idx) => {
                const isActive = agent.slug === selectedSlug;
                return (
                  <button
                    key={agent.slug}
                    role="option"
                    aria-selected={isActive}
                    type="button"
                    onClick={() => {
                      onSelect(agent.slug);
                      setOpen(false);
                      setQuery("");
                    }}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: "12px 14px",
                      background: isActive ? "var(--ta-accent-soft)" : "transparent",
                      border: "none",
                      borderBottom:
                        idx < filtered.length - 1
                          ? "1px solid var(--ta-border)"
                          : "none",
                      cursor: "pointer",
                      display: "flex",
                      gap: 12,
                      alignItems: "flex-start",
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive)
                        (e.currentTarget as HTMLButtonElement).style.background =
                          "var(--ta-hover)";
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive)
                        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                    }}
                  >
                    <AgentAvatar agent={agent} size={36} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {/* Name row */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          marginBottom: 4,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: "var(--ta-text)",
                          }}
                        >
                          {agent.name}
                        </span>
                        {isActive && (
                          <Check size={12} color="var(--ta-accent)" style={{ flexShrink: 0 }} />
                        )}
                        <span
                          style={{
                            fontSize: 11,
                            color: "var(--ta-accent)",
                            marginLeft: "auto",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {agent.specialty}
                        </span>
                      </div>
                      {/* Bio */}
                      <p
                        style={{
                          margin: "0 0 6px",
                          fontSize: 11.5,
                          color: "var(--ta-text-soft)",
                          lineHeight: 1.45,
                        }}
                      >
                        {agent.bio[0]}
                      </p>
                      {/* Tags */}
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 4,
                          marginBottom: 5,
                        }}
                      >
                        {agent.quizTags.map((tag) => (
                          <span
                            key={tag}
                            style={{
                              fontSize: 10,
                              padding: "2px 6px",
                              background: "var(--ta-surface-2)",
                              border: "1px solid var(--ta-border)",
                              borderRadius: 4,
                              color: "var(--ta-text-soft)",
                              fontFamily: "var(--font-geist-mono, monospace)",
                            }}
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                      {/* Best for */}
                      <div style={{ fontSize: 11, color: "var(--ta-text-mute)" }}>
                        <span style={{ fontWeight: 600 }}>Best for: </span>
                        {agent.tagline}
                      </div>
                    </div>
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <p
                  style={{
                    padding: "24px 14px",
                    textAlign: "center",
                    color: "var(--ta-text-mute)",
                    fontSize: 12,
                  }}
                >
                  No agents match &ldquo;{query}&rdquo;
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
