// Layout shell for every page in the (console) route group — the tenant
// Admin Console. Two columns: left = ConsoleSidebar (collapsible groupings
// of console pages), right = page content. Slim top bar: sidebar toggle +
// platform logo on the left, the canonical role-aware app hamburger on the
// right (same menu as the dashboard and CRM pages — Dashboard, Workspace/CRM,
// My account, Admin Console, profile, sign out). The sidebar and the
// hamburger are intentionally different surfaces: the hamburger is
// cross-app navigation, the sidebar is the console's own sub-pages.
//
// Platform branding everywhere TA-facing (#962 follow-up): this surface is
// staff-only, so it shows the AI Travel Concierge logo, never tenant
// white-label. Mirrors AdminShell's chrome so the app shells stay
// consistent.
//
// Client component for the toggle + dropdown state. Auth + owner-scope are
// enforced upstream in (console)/layout.tsx — this shell renders only after
// that gate passes; role is threaded down (no client-side auth lookup).

"use client";

import * as React from "react";
import Link from "next/link";
import { Moon, PanelLeft, Sun } from "lucide-react";
import { Logo } from "@/components/branding/Logo";
import { LogoMark } from "@/components/branding/LogoMark";
import { SiteHeaderMenu } from "@/components/site-header/SiteHeaderMenu";
import { ConsoleSidebar } from "./ConsoleSidebar";
import { useTaTheme, ICON_BTN_STYLE } from "@/lib/ta-theme/use-ta-theme";
import type { UserRole } from "@/lib/auth/permission-grants";

export interface ConsoleShellProps {
  children: React.ReactNode;
  /** Initial collapsed-sections state read from the cookie on the server,
   *  threaded through so the first paint matches the owner's saved state
   *  with no client-side flash (#669). */
  initialCollapsed: Record<string, boolean>;
  /** The signed-in user's role — controls which sidebar sections show. */
  role: UserRole;
}

export function ConsoleShell({
  children,
  initialCollapsed,
  role,
}: Readonly<ConsoleShellProps>): React.ReactElement {
  // null = the visitor hasn't toggled yet → CSS-only default (closed below
  // lg, open on lg+). See ConsoleSidebar for why this can't be a boolean.
  const [open, setOpen] = React.useState<boolean | null>(null);

  const toggle = (): void =>
    setOpen((prev) =>
      prev === null
        ? !window.matchMedia("(min-width: 1024px)").matches
        : !prev,
    );

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
            onClick={toggle}
            aria-label="Toggle navigation"
            style={{ ...ICON_BTN_STYLE, color: "var(--ta-text-soft)" }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "var(--ta-hover)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
            }}
          >
            <PanelLeft className="h-5 w-5" />
          </button>
          <Link
            href="/settings"
            aria-label="Admin Console home"
            className="flex items-center gap-2"
          >
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
              Admin Console
            </span>
          </Link>
        </div>
        <div className="flex items-center gap-1">
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
          {/* Canonical role-aware app nav — identical to the dashboard and
              CRM-page hamburger so navigation (incl. Workspace/CRM and My
              account) stays consistent across every tenant screen. The
              ConsoleSidebar below carries the console's own sub-page nav. */}
          <SiteHeaderMenu isPlatformDomain={false} isAuthenticated role={role} />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <ConsoleSidebar open={open} initialCollapsed={initialCollapsed} role={role} />
        <main className="min-w-0 flex-1 overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
