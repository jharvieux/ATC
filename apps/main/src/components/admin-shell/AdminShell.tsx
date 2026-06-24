// Layout shell for every page in the (admin) route group. Two columns:
// left = AdminSidebar (collapsible groupings of admin pages), right =
// page content. Includes a slim top bar with logo + sidebar toggle so
// the operator can reclaim horizontal space.
//
// Client component for the toggle state. Auth is still enforced
// upstream in (admin)/layout.tsx — this shell is rendered only AFTER
// the platform-admin gate passes.

"use client";

import * as React from "react";
import Link from "next/link";
import { Menu, Moon, Sun } from "lucide-react";
import { Logo } from "@/components/branding/Logo";
import { LogoMark } from "@/components/branding/LogoMark";
import { AdminSidebar } from "./AdminSidebar";
import { useTaTheme, ICON_BTN_STYLE } from "@/lib/ta-theme/use-ta-theme";
import type { PlatformAdminRole } from "@/lib/auth/platform-admin-roles";

export interface AdminShellProps {
  children: React.ReactNode;
  /** Initial collapsed-sections state read from the cookie on the
   *  server, threaded through so the first paint matches the operator's
   *  saved state without a client-side flash (#669). */
  initialCollapsed: Record<string, boolean>;
  /** The current admin's role — controls which sidebar sections are shown. */
  adminRole: PlatformAdminRole | "service";
}

export function AdminShell({
  children,
  initialCollapsed,
  adminRole,
}: Readonly<AdminShellProps>): React.ReactElement {
  const [open, setOpen] = React.useState(true);
  const [taTheme, toggleTheme] = useTaTheme();

  return (
    <div
      className="flex min-h-screen flex-col"
      style={{ background: "var(--ta-bg)", color: "var(--ta-text)" }}
    >
      <header
        className="flex items-center justify-between px-4 py-3"
        style={{
          background: "var(--ta-sidebar)",
          borderBottom: "1px solid var(--ta-border)",
          color: "var(--ta-text)",
        }}
      >
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
            style={{ ...ICON_BTN_STYLE, color: "var(--ta-text-soft)" }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "var(--ta-hover)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
            }}
          >
            <Menu className="h-5 w-5" />
          </button>
          <Link href="/admin" aria-label="Admin home" className="flex items-center gap-2">
            <span className="hidden sm:inline-flex">
              <Logo height={49} />
            </span>
            <span className="sm:hidden">
              <LogoMark size={49} />
            </span>
            <span
              className="text-xs font-semibold uppercase tracking-wide"
              style={{ color: "var(--ta-text-mute)" }}
            >
              Admin
            </span>
          </Link>
        </div>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={`Switch to ${taTheme === "dark" ? "light" : "dark"} theme`}
          title={`Switch to ${taTheme === "dark" ? "light" : "dark"} theme`}
          style={{ ...ICON_BTN_STYLE, color: "var(--ta-text-soft)" }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "var(--ta-hover)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          }}
        >
          {taTheme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </header>
      <div className="flex flex-1">
        <AdminSidebar pinned={open} initialCollapsed={initialCollapsed} adminRole={adminRole} />
        <main className="flex-1 overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
