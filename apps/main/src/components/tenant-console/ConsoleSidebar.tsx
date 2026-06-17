// Tenant Admin Console left sidebar. Sections from sidebar-sections.ts;
// each section is collapsible (chevron toggle); the open/closed state per
// section is persisted to a server-readable cookie (collapsed-cookie.ts)
// so the initial SSR HTML matches the owner's saved state — no hydration
// flash (#669). The whole sidebar can also collapse on small screens
// (toggle in the ConsoleShell header) — that is also the mobile pattern.
//
// Client component: usePathname for active-link highlight + document.cookie
// writes on toggle. Reads come from `initialCollapsed` (server-threaded).

"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { isActiveLink } from "@/components/admin-shell/is-active-link";
import {
  filterConsoleNavForRole,
  type ConsoleNavSection,
} from "./sidebar-sections";
import { serializeCollapsedCookie } from "./collapsed-cookie";
import type { UserRole } from "@/lib/auth/permission-grants";

function saveCollapsed(state: Record<string, boolean>): void {
  if (typeof window === "undefined") return;
  document.cookie = serializeCollapsedCookie(state);
}

export interface ConsoleSidebarProps {
  /** Sidebar width via Tailwind, tri-state to keep the first paint correct
   *  on both form factors with no hydration flash:
   *  - `open=null`  → CSS default: `w-0` below `lg`, `w-64` on `lg`+ (the
   *    visitor hasn't toggled yet; closed on mobile, open on desktop).
   *  - `open=true`  → `w-64` on all viewports.
   *  - `open=false` → `w-0` on all viewports.
   *  Driven by the toggle button in the ConsoleShell top bar. */
  open: boolean | null;
  /** Persisted collapsed-sections state read from the cookie on the
   *  server. Threaded down so the first client render matches the SSR
   *  HTML — no flash (#669). */
  initialCollapsed: Record<string, boolean>;
  /** The signed-in user's role — filters which sections/items are shown. */
  role: UserRole;
}

export function ConsoleSidebar({
  open,
  initialCollapsed,
  role,
}: ConsoleSidebarProps): React.ReactElement {
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

  const visibleSections = filterConsoleNavForRole(role);

  return (
    <aside
      className={cn(
        "border-r border-border bg-background transition-all overflow-hidden",
        open === null ? "w-0 lg:w-64" : open ? "w-64" : "w-0",
      )}
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
  section: ConsoleNavSection;
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
