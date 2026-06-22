"use client";

// #962 / #974 — Landing shell for authenticated SaaS users at the tenant
// subdomain root.
//   - Staff (tenant_owner/agent): ChatGPT-style dashboard. Platform branding
//     — this surface is staff-only, so it never shows tenant white-label
//     (that stays on end-customer surfaces). Workspace nav lives in the
//     persistent left WorkspaceSidebar; the conversation rail inside
//     ConciergeExperience is toggled by the PanelLeft button, shared via
//     ConversationRailContext.
//   - Viewers (end customers): unchanged — tenant BrandLogo + ChatExperience,
//     no WorkspaceSidebar, full nav in the dropdown.
//
// Client component for the toggle + dropdown state; role is resolved
// server-side in app/page.tsx and passed down — no client-side auth lookup.

import * as React from "react";
import Link from "next/link";
import { Menu, Moon, PanelLeft, Sun } from "lucide-react";
import { Logo } from "@/components/branding/Logo";
import { LogoMark } from "@/components/branding/LogoMark";
import {
  BrandLogo,
  type BrandLogoBranding,
} from "@/components/branding/BrandLogo";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { performSignout } from "@/lib/auth/perform-signout";
import { navSectionsForRole } from "./nav-sections";
import { ConversationRailContext } from "./conversation-rail-context";
import { useTaTheme, ICON_BTN_STYLE } from "@/lib/ta-theme/use-ta-theme";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import type { UserRole } from "@/lib/auth/permission-grants";

export interface TenantShellProps {
  role: UserRole;
  /** Tenant logo/name for the viewer top bar (§16). Ignored for staff, who
   *  always get the platform logo. */
  branding?: BrandLogoBranding | null;
  children: React.ReactNode;
  /** OAuth avatar URL for the signed-in user; null for email-only accounts. */
  avatarUrl?: string | null;
  /** Display name (full_name, name, or email) for the signed-in user. */
  displayName?: string | null;
}

export function TenantShell({
  role,
  branding = null,
  children,
  avatarUrl = null,
  displayName = null,
}: Readonly<TenantShellProps>): React.ReactElement {
  const isStaff = role === "tenant_owner" || role === "agent";
  const sections = navSectionsForRole(role);

  // TA theme — shared hook writes data-ta-theme on documentElement and
  // syncs across all mounted instances via "ta-theme-change" custom event.
  const [taTheme, toggleTheme] = useTaTheme();

  // WorkspaceSidebar open/close (staff only). Tri-state: null = visitor
  // hasn't toggled yet → CSS-only default (closed below lg, open on lg+).
  const [workspaceOpen, setWorkspaceOpen] = React.useState<boolean | null>(null);
  const toggleWorkspace = React.useCallback((): void => {
    setWorkspaceOpen((prev) =>
      prev === null
        ? !window.matchMedia("(min-width: 1024px)").matches
        : !prev,
    );
  }, []);

  // Tri-state collapse for the staff conversation rail (ConciergeExperience),
  // shared via context. null = visitor hasn't toggled → CSS-only default
  // (closed below lg, open lg+) so the first paint has no hydration flash.
  const [open, setOpen] = React.useState<boolean | null>(null);
  const toggle = React.useCallback((): void => {
    setOpen((prev) =>
      prev === null
        ? !window.matchMedia("(min-width: 1024px)").matches
        : !prev,
    );
  }, []);

  return (
    <ConversationRailContext.Provider value={{ open, toggle }}>
      <div
        className="flex h-screen flex-col"
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
            {isStaff && (
              <button
                type="button"
                onClick={toggleWorkspace}
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
            )}
            <Link href="/" aria-label="Home" className="flex items-center">
              {isStaff ? (
                <>
                  <span className="hidden sm:inline-flex">
                    <Logo height={49} />
                  </span>
                  <span className="sm:hidden">
                    <LogoMark size={49} />
                  </span>
                </>
              ) : (
                <BrandLogo branding={branding} height={49} />
              )}
            </Link>
          </div>
          <div className="flex items-center gap-1">
            {/* Theme toggle — syncs with ConciergeExperience via the shared
                useTaTheme hook and "ta-theme-change" custom event. */}
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  aria-label="Open menu"
                  className="h-10 w-10 px-0 rounded-full"
                >
                  {/* TenantShell only renders for authenticated staff roles, so isAuthenticated
                      check is implicit — avatarUrl is only non-null when a user is present. */}
                  {avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={avatarUrl} alt="" referrerPolicy="no-referrer" className="h-7 w-7 rounded-full object-cover" />
                  ) : displayName ? (
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary leading-none">
                      {displayName[0]?.toUpperCase()}
                    </span>
                  ) : (
                    <Menu className="h-5 w-5" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {sections.map((section, i) => (
                  <React.Fragment key={section.heading ?? `home-${i}`}>
                    {i > 0 && <DropdownMenuSeparator />}
                    {section.heading && (
                      <DropdownMenuLabel>{section.heading}</DropdownMenuLabel>
                    )}
                    {section.items.map((item) => (
                      <DropdownMenuItem asChild key={item.href}>
                        <Link href={item.href}>{item.label}</Link>
                      </DropdownMenuItem>
                    ))}
                  </React.Fragment>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings/profile">View profile</Link>
                </DropdownMenuItem>
                {/* onSelect (not a nested <form>) so ENTER/SPACE on the
                    highlighted item fire the action — see SiteHeaderMenu (#664). */}
                <DropdownMenuItem onSelect={performSignout}>
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {isStaff && (
            <WorkspaceSidebar
              open={workspaceOpen}
              role={role}
              onNavigate={() => {
                if (!window.matchMedia("(min-width: 1024px)").matches) setWorkspaceOpen(false);
              }}
            />
          )}
          <main className="min-h-0 flex-1 overflow-x-hidden">{children}</main>
        </div>
      </div>
    </ConversationRailContext.Provider>
  );
}
