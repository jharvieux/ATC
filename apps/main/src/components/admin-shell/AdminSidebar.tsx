// Platform-admin left sidebar. Sections from sidebar-sections.ts; each
// section is collapsible (chevron toggle); the open/closed state per
// section is persisted to a server-readable cookie (collapsed-cookie.ts)
// so the initial SSR HTML matches the operator's saved state — no
// hydration flash (#669). The whole sidebar can also collapse on small
// screens (toggle in the AdminShell header).
//
// Client component: usePathname for active-link highlight + document.cookie
// writes on toggle. Reads come from `initialCollapsed` (server-threaded).

"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { TaSidebarLink } from "@/lib/ta-theme/ta-sidebar-link";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { filterNavForRole, type AdminNavSection } from "./sidebar-sections";
import type { PlatformAdminRole } from "@/lib/auth/platform-admin-roles";
import { isActiveLink } from "./is-active-link";
import { serializeCollapsedCookie } from "./collapsed-cookie";

function saveCollapsed(state: Record<string, boolean>): void {
  if (typeof window === "undefined") return;
  // Cookie-based persistence so the parent server layout can read the
  // initial state and ship correct SSR HTML — no all-open-flash on
  // hydration (#669). See collapsed-cookie.ts for the contract.
  document.cookie = serializeCollapsedCookie(state);
}

export interface AdminSidebarProps {
  /** Toggles the sidebar width via Tailwind:
   *  - `open=true`  → `w-64` on all viewports.
   *  - `open=false` → `w-0` below `lg`, but `w-64` on `lg` and up — desktop
   *    keeps the sidebar permanently visible so the operator never loses
   *    nav. Driven by the hamburger button in the AdminShell top bar. */
  open: boolean;
  /** Persisted collapsed-sections state read from the cookie on the
   *  server. Threaded down so the first client render matches the SSR
   *  HTML — no flash (#669). */
  initialCollapsed: Record<string, boolean>;
  /** The current admin's role — filters which sections and items are shown. */
  adminRole: PlatformAdminRole | "service";
}

export function AdminSidebar({
  open,
  initialCollapsed,
  adminRole,
}: AdminSidebarProps): React.ReactElement {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>(
    initialCollapsed,
  );

  const toggle = React.useCallback((heading: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [heading]: !prev[heading] };
      saveCollapsed(next);
      return next;
    });
  }, []);

  const visibleSections = filterNavForRole(adminRole);

  return (
    <aside
      className={cn(
        "transition-all overflow-hidden",
        open ? "w-64" : "w-0 lg:w-64",
      )}
      style={{
        background: "var(--ta-sidebar)",
        borderRight: "1px solid var(--ta-border)",
      }}
    >
      <nav className="flex flex-col gap-4 px-3 py-6">
        {visibleSections.map((section) => (
          <Section
            key={section.heading}
            section={section}
            collapsed={collapsed[section.heading] === true}
            onToggle={() => toggle(section.heading)}
            currentPath={pathname}
          />
        ))}
      </nav>
    </aside>
  );
}

function Section({
  section,
  collapsed,
  onToggle,
  currentPath,
}: {
  section: AdminNavSection;
  collapsed: boolean;
  onToggle: () => void;
  currentPath: string | null;
}): React.ReactElement {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between rounded-md px-2 py-1.5"
        style={{
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--ta-text-mute)",
          background: "transparent",
          border: "none",
          cursor: "pointer",
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
          <ChevronRight className="h-3 w-3" style={{ color: "var(--ta-text-mute)" }} />
        ) : (
          <ChevronDown className="h-3 w-3" style={{ color: "var(--ta-text-mute)" }} />
        )}
      </button>
      {!collapsed && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {section.items.map((item) => {
            const active = isActiveLink(currentPath, item.href);
            return (
              <li key={item.href}>
                <TaSidebarLink href={item.href} label={item.label} active={active} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
