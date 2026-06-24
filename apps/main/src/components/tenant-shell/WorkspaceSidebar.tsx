"use client";

// Persistent left sidebar for the TA workspace (staff only).
//
// Collapse/expand behavior:
//   • Default: collapsed (48 px, icon-only). No hydration flash — no server
//     prop controls this anymore; all state is internal.
//   • Desktop: hover over the sidebar to temporarily expand (240 px).
//   • Pinned: clicking the toggle button pins it open; clicking again unpins.
//     On narrow screens (< md) navigating auto-unpins.
//
// Sections come from sidebarSectionsForRole() which excludes "My account"
// (those items live in the avatar/hamburger dropdown) and includes Price
// watches under Workspace for staff.

import * as React from "react";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  MessageSquare,
  Users,
  FileText,
  Calendar,
  Upload,
  BarChart2,
  TrendingDown,
  MessageCircle,
  Shield,
  Settings,
  PanelLeftOpen,
  PanelLeft,
} from "lucide-react";
import { sidebarSectionsForRole } from "./nav-sections";
import { TaSidebarLink } from "@/lib/ta-theme/ta-sidebar-link";
import type { UserRole } from "@/lib/auth/permission-grants";

const NAV_ICONS: Record<string, React.ElementType> = {
  "Dashboard": LayoutDashboard,
  "Support chat": MessageSquare,
  "Contacts": Users,
  "Quotes": FileText,
  "Bookings": Calendar,
  "Imports": Upload,
  "Reports": BarChart2,
  "Price watches": TrendingDown,
  "Conversations": MessageCircle,
  "Privacy & data": Shield,
  "Admin Console": Settings,
};

const COLLAPSED_W = 48;
const EXPANDED_W = 240;

export interface WorkspaceSidebarProps {
  role: UserRole;
}

export function WorkspaceSidebar({ role }: WorkspaceSidebarProps): React.ReactElement {
  const pathname = usePathname();
  const sections = sidebarSectionsForRole(role);

  const [hovered, setHovered] = React.useState(false);
  const [pinned, setPinned] = React.useState(false);

  const expanded = pinned || hovered;

  const handleNavigate = React.useCallback(() => {
    // Auto-unpin on mobile so the sidebar doesn't stay open after nav
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches) {
      setPinned(false);
    }
  }, []);

  const ICON_BTN: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 32,
    height: 32,
    borderRadius: 6,
    border: "none",
    background: "transparent",
    cursor: "pointer",
    color: "var(--ta-text-soft)",
    flexShrink: 0,
    transition: "background 0.12s, color 0.12s",
  };

  return (
    <aside
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: expanded ? EXPANDED_W : COLLAPSED_W,
        flexShrink: 0,
        overflow: "hidden",
        transition: "width 0.18s ease",
        background: "var(--ta-sidebar)",
        borderRight: "1px solid var(--ta-border)",
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      {/* Inner container keeps layout stable during width transition */}
      <div style={{ width: EXPANDED_W, display: "flex", flexDirection: "column", height: "100%" }}>
        {/* Toggle button row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: expanded ? "flex-end" : "center",
            padding: "10px 8px 4px",
          }}
        >
          <button
            type="button"
            aria-label={pinned ? "Collapse navigation" : "Pin navigation open"}
            style={ICON_BTN}
            onClick={() => setPinned((p) => !p)}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "var(--ta-hover)";
              (e.currentTarget as HTMLButtonElement).style.color = "var(--ta-text)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              (e.currentTarget as HTMLButtonElement).style.color = "var(--ta-text-soft)";
            }}
          >
            {pinned ? <PanelLeft size={16} strokeWidth={1.75} /> : <PanelLeftOpen size={16} strokeWidth={1.75} />}
          </button>
        </div>

        {/* Nav sections */}
        <nav
          style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "8px 8px 24px" }}
        >
          {sections.map((section, i) => (
            <SidebarSection
              key={section.heading ?? `section-${i}`}
              heading={section.heading}
              items={section.items}
              currentPath={pathname}
              expanded={expanded}
              onNavigate={handleNavigate}
            />
          ))}
        </nav>
      </div>
    </aside>
  );
}

function SidebarSection({
  heading,
  items,
  currentPath,
  expanded,
  onNavigate,
}: {
  heading: string | null;
  items: readonly { href: string; label: string }[];
  currentPath: string | null;
  expanded: boolean;
  onNavigate?: (() => void) | undefined;
}): React.ReactElement {
  return (
    <div style={{ marginBottom: 16 }}>
      {heading && expanded && (
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.7,
            textTransform: "uppercase",
            color: "var(--ta-text-mute)",
            padding: "2px 8px 6px",
            whiteSpace: "nowrap",
            overflow: "hidden",
          }}
        >
          {heading}
        </div>
      )}
      {/* Spacer when collapsed so sections are still visually separated */}
      {heading && !expanded && <div style={{ height: 8 }} />}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 1 }}>
        {items.map((item) => {
          const active =
            currentPath === item.href ||
            (item.href !== "/" && currentPath !== null && currentPath.startsWith(item.href + "/"));
          const Icon = NAV_ICONS[item.label];
          return (
            <li key={item.href}>
              <TaSidebarLink
                href={item.href}
                label={item.label}
                active={active}
                {...(Icon ? { icon: Icon } : {})}
                collapsed={!expanded}
                variant="workspace"
                {...(onNavigate ? { onNavigate } : {})}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
