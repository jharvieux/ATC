"use client";

// #1781/#1791 — extracted from ConciergeExperience.tsx (was a 925-line file
// with 4 sub-components defined inline). Renders one labeled group of
// conversation rows ("Today" / "Earlier") in the Chats sidebar panel.

import { formatDate } from "@/lib/format-date";
import type { TaConversation } from "@/lib/concierge/use-concierge-conversations";

export function ConvGroup({
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
                {c.last_message_at ? formatDate(c.last_message_at) : "—"}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
