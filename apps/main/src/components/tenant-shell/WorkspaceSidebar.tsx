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
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { navSectionsForRole } from "./nav-sections";
import type { UserRole } from "@/lib/auth/permission-grants";

export interface WorkspaceSidebarProps {
  open: boolean | null;
  role: UserRole;
}

export function WorkspaceSidebar({ open, role }: WorkspaceSidebarProps): React.ReactElement {
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
      {/* Fixed inner width so content doesn't reflow during the open/close animation */}
      <div className="flex h-full flex-col" style={{ width: 256 }}>
        <nav className="flex flex-col gap-4 overflow-y-auto" style={{ padding: "24px 12px" }}>
          {sections.map((section, i) => (
            <SidebarSection
              key={section.heading ?? `section-${i}`}
              heading={section.heading}
              items={section.items}
              currentPath={pathname}
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
}: {
  heading: string | null;
  items: readonly { href: string; label: string }[];
  currentPath: string | null;
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
              <SidebarLink href={item.href} label={item.label} active={active} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SidebarLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}): React.ReactElement {
  const [hovered, setHovered] = React.useState(false);

  const style: React.CSSProperties = active
    ? {
        display: "block",
        borderRadius: 7,
        padding: "7px 10px",
        fontSize: 13,
        fontWeight: 600,
        background: "var(--ta-accent-soft)",
        color: "var(--ta-accent)",
        textDecoration: "none",
        transition: "background 0.12s, color 0.12s",
      }
    : {
        display: "block",
        borderRadius: 7,
        padding: "7px 10px",
        fontSize: 13,
        fontWeight: 400,
        background: hovered ? "var(--ta-hover)" : "transparent",
        color: hovered ? "var(--ta-text)" : "var(--ta-text-soft)",
        textDecoration: "none",
        transition: "background 0.12s, color 0.12s",
      };

  return (
    <Link
      href={href}
      style={style}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {label}
    </Link>
  );
}
