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

const STORAGE_KEY = "atc.admin.sidebar.collapsed-sections.v1";

function loadCollapsed(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    // Parsed shape isn't trusted — return empty map on any irregularity.
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, boolean>;
  } catch {
    return {};
  }
}

function saveCollapsed(state: Record<string, boolean>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota-exceeded / disabled storage — sidebar still functions for
    // this session, just won't persist on the next visit. Not surfacing
    // the failure to the operator because the consequence is invisible.
  }
}

export interface AdminSidebarProps {
  /** When false, the sidebar still occupies space but hides its body
   *  content (used by the mobile/small-screen collapse toggle in
   *  AdminShell). */
  open: boolean;
}

export function AdminSidebar({ open }: AdminSidebarProps): React.ReactElement {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>(
    {},
  );

  // Hydrate from localStorage after mount — the first paint matches the
  // server-rendered "all open" state to avoid hydration mismatch.
  React.useEffect(() => {
    setCollapsed(loadCollapsed());
  }, []);

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
            const active = currentPath === item.href;
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
