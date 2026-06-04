// Platform-admin left sidebar. Sections from sidebar-sections.ts; each
// section is collapsible (chevron toggle); the open/closed state per
// section is persisted to localStorage so the operator's setup survives
// page navigation. The whole sidebar can also collapse on small screens
// (toggle in the AdminShell header).
//
// Client component: localStorage + usePathname for active-link highlight.

"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ADMIN_NAV_SECTIONS, type AdminNavSection } from "./sidebar-sections";
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
}

export function AdminSidebar({
  open,
  initialCollapsed,
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

  return (
    <aside
      className={cn(
        "border-r border-border bg-background transition-all overflow-hidden",
        open ? "w-64" : "w-0 lg:w-64",
      )}
    >
      <nav className="flex flex-col gap-4 px-3 py-6">
        {ADMIN_NAV_SECTIONS.map((section) => (
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
        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-accent"
        aria-expanded={!collapsed}
      >
        <span>{section.heading}</span>
        {collapsed ? (
          <ChevronRight className="h-3 w-3" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        )}
      </button>
      {!collapsed && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {section.items.map((item) => {
            const active = isActiveLink(currentPath, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    "block rounded-md px-2 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-foreground/80 hover:bg-accent/60",
                  )}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
