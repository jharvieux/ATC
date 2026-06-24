// Platform-admin left sidebar. Sections from sidebar-sections.ts; each
// section is collapsible (chevron toggle) when the sidebar is expanded.
//
// Sidebar collapse behavior matches WorkspaceSidebar:
//   • pinned=true  → expanded (240px)
//   • pinned=false → icon-only (48px); hover temporarily expands to 240px
//
// Section-level collapse persists via cookie (collapsed-cookie.ts) so the
// initial SSR HTML matches the operator's saved state — no hydration flash
// (#669). When the sidebar is in icon-only mode, all items render as icons
// regardless of section-collapsed state.

"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import {
  ClipboardList,
  ShieldAlert,
  Ban,
  Users,
  Bot,
  Database,
  SlidersHorizontal,
  FileX,
  Rss,
  Anchor,
  Scale,
  LifeBuoy,
  CreditCard,
  Receipt,
  Activity,
  Server,
  Mail,
  Cloud,
  Monitor,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { TaSidebarLink } from "@/lib/ta-theme/ta-sidebar-link";
import { filterNavForRole, type AdminNavSection } from "./sidebar-sections";
import type { PlatformAdminRole } from "@/lib/auth/platform-admin-roles";
import { isActiveLink } from "./is-active-link";
import { serializeCollapsedCookie } from "./collapsed-cookie";

const COLLAPSED_W = 48;
const EXPANDED_W = 240;

const NAV_ICONS: Record<string, React.ElementType> = {
  "Tenant Review Queue": ClipboardList,
  "Abuse Monitoring": ShieldAlert,
  "Content Deny-list": Ban,
  "Platform Admins": Users,
  "Personas": Bot,
  "RAG Authority Overrides": Database,
  "Retrieval Weights": SlidersHorizontal,
  "Post-termination Chunks": FileX,
  "Travel News Feeds": Rss,
  "Cruise Catalog": Anchor,
  "Legal Documents": Scale,
  "Help Triage": LifeBuoy,
  "Subscription Pricing": CreditCard,
  "Commission Reconciliation": Receipt,
  "Cost & Resource Monitoring": Activity,
  "Vendor Status": Server,
  "Email Samples": Mail,
  "Weather Integration": Cloud,
  "Supervisor": Monitor,
};

function saveCollapsed(state: Record<string, boolean>): void {
  if (typeof window === "undefined") return;
  document.cookie = serializeCollapsedCookie(state);
}

export interface AdminSidebarProps {
  /** When true, sidebar is pinned open (240px). When false, collapses to
   *  icon-only (48px) and temporarily expands on hover. */
  pinned: boolean;
  /** Persisted collapsed-sections state read from the cookie on the
   *  server. Threaded down so the first client render matches the SSR
   *  HTML — no flash (#669). */
  initialCollapsed: Record<string, boolean>;
  /** The current admin's role — filters which sections and items are shown. */
  adminRole: PlatformAdminRole | "service";
}

export function AdminSidebar({
  pinned,
  initialCollapsed,
  adminRole,
}: AdminSidebarProps): React.ReactElement {
  const pathname = usePathname();
  const [sectionCollapsed, setSectionCollapsed] = React.useState<Record<string, boolean>>(
    initialCollapsed,
  );
  const [hovered, setHovered] = React.useState(false);

  const expanded = pinned || hovered;

  const toggle = React.useCallback((heading: string) => {
    setSectionCollapsed((prev) => {
      const next = { ...prev, [heading]: !prev[heading] };
      saveCollapsed(next);
      return next;
    });
  }, []);

  const visibleSections = filterNavForRole(adminRole);

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
      }}
    >
      {/* Fixed-width inner container so layout is stable during the
          width transition. Links anchor themselves within the 48px
          visible area via paddingLeft when collapsed. */}
      <div style={{ width: EXPANDED_W, display: "flex", flexDirection: "column" }}>
        <nav style={{ padding: "16px 8px 24px" }}>
          {visibleSections.map((section) => (
            <Section
              key={section.heading}
              section={section}
              collapsed={sectionCollapsed[section.heading] === true}
              onToggle={() => toggle(section.heading)}
              currentPath={pathname}
              sidebarExpanded={expanded}
            />
          ))}
        </nav>
      </div>
    </aside>
  );
}

function Section({
  section,
  collapsed,
  onToggle,
  currentPath,
  sidebarExpanded,
}: {
  section: AdminNavSection;
  collapsed: boolean;
  onToggle: () => void;
  currentPath: string | null;
  sidebarExpanded: boolean;
}): React.ReactElement {
  // In icon-only mode, all items are visible regardless of section collapsed state.
  const showItems = !sidebarExpanded || !collapsed;

  return (
    <div style={{ marginBottom: 8 }}>
      {sidebarExpanded ? (
        <button
          type="button"
          onClick={onToggle}
          style={{
            display: "flex",
            width: "100%",
            alignItems: "center",
            justifyContent: "space-between",
            borderRadius: 6,
            padding: "4px 8px 6px",
            fontSize: 11,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--ta-text-mute)",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
          aria-expanded={!collapsed}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "var(--ta-hover)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          }}
        >
          <span>{section.heading}</span>
          {collapsed ? (
            <ChevronRight style={{ width: 12, height: 12, color: "var(--ta-text-mute)", flexShrink: 0 }} />
          ) : (
            <ChevronDown style={{ width: 12, height: 12, color: "var(--ta-text-mute)", flexShrink: 0 }} />
          )}
        </button>
      ) : (
        <div style={{ height: 8 }} />
      )}
      {showItems && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 1 }}>
          {section.items.map((item) => {
            const active = isActiveLink(currentPath, item.href);
            const Icon = NAV_ICONS[item.label];
            return (
              <li key={item.href}>
                <TaSidebarLink
                  href={item.href}
                  label={item.label}
                  active={active}
                  {...(Icon ? { icon: Icon } : {})}
                  collapsed={!sidebarExpanded}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
