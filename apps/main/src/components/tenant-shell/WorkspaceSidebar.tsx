"use client";

// Persistent left sidebar for the TenantShell (staff only). Shows all
// workspace navigation (Dashboard, Workspace, My Account, Admin Console)
// using [data-ta-theme] CSS custom properties — same token set as
// ConciergeExperience — so the sidebar inherits the active dark/light theme.
//
// Tri-state `open` prop mirrors ConsoleSidebar / AdminSidebar convention:
//   null  = CSS default (w-0 below lg, w-64 on lg+) — no hydration flash
//   true  = always open
//   false = always closed
//
// Color classes are intentionally absent — inline styles with --ta-* vars only.

import * as React from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { navSectionsForRole } from "./nav-sections";
import { TaSidebarLink } from "@/lib/ta-theme/ta-sidebar-link";
import type { UserRole } from "@/lib/auth/permission-grants";

export interface WorkspaceSidebarProps {
  open: boolean | null;
  role: UserRole;
  onNavigate?: () => void;
}

export function WorkspaceSidebar({ open, role, onNavigate }: WorkspaceSidebarProps): React.ReactElement {
  const pathname = usePathname();
  const sections = navSectionsForRole(role);

  return (
    <aside
      className={cn(
        "shrink-0 overflow-hidden transition-all duration-200",
        open === null ? "w-0 lg:w-64" : open ? "w-64" : "w-0",
      )}
      style={{
        background: "var(--ta-sidebar)",
        borderRight: "1px solid var(--ta-border)",
      }}
    >
      {/* Inner width matches parent w-64 (256px) — keeps text laid out
          during the overflow:hidden transition so content doesn't reflow */}
      <div className="flex h-full flex-col" style={{ width: 256 }}>
        <nav className="flex flex-col gap-4 overflow-y-auto" style={{ padding: "24px 12px" }}>
          {sections.map((section, i) => (
            <SidebarSection
              key={section.heading ?? `section-${i}`}
              heading={section.heading}
              items={section.items}
              currentPath={pathname}
              onNavigate={onNavigate}
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
  onNavigate,
}: {
  heading: string | null;
  items: readonly { href: string; label: string }[];
  currentPath: string | null;
  onNavigate?: (() => void) | undefined;
}): React.ReactElement {
  return (
    <div>
      {heading && (
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.7,
            textTransform: "uppercase",
            color: "var(--ta-text-mute)",
            padding: "2px 8px 6px",
          }}
        >
          {heading}
        </div>
      )}
      <ul className="flex flex-col" style={{ gap: 1 }}>
        {items.map((item) => {
          const active =
            currentPath === item.href ||
            (item.href !== "/" && currentPath !== null && currentPath.startsWith(item.href + "/"));
          return (
            <li key={item.href}>
              <TaSidebarLink href={item.href} label={item.label} active={active} variant="workspace" onNavigate={onNavigate} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
