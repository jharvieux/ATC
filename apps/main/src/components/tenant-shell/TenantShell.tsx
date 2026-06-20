"use client";

// #962 / #974 — Landing shell for authenticated SaaS users at the tenant
// subdomain root.
//   - Staff (tenant_owner/agent): ChatGPT-style dashboard. Platform branding
//     — this surface is staff-only, so it never shows tenant white-label
//     (that stays on end-customer surfaces). App navigation lives in the
//     top-right hamburger; the only left rail is the conversation history
//     inside ConciergeExperience, whose collapse is driven by the PanelLeft
//     toggle here, shared via ConversationRailContext.
//   - Viewers (end customers): unchanged — tenant BrandLogo + ChatExperience,
//     no conversation rail and no left-rail toggle.
//
// Client component for the toggle + dropdown state; role is resolved
// server-side in app/page.tsx and passed down — no client-side auth lookup.

import * as React from "react";
import Link from "next/link";
import { Menu, PanelLeft } from "lucide-react";
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
      <div className="flex h-screen flex-col">
        <header className="flex items-center justify-between border-b border-border bg-background px-4 py-3">
          <div className="flex items-center gap-3">
            {isStaff && (
              <button
                type="button"
                onClick={toggle}
                aria-label="Toggle conversation history"
                className="rounded-md p-1.5 hover:bg-accent"
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
          {/* Slot for page-level toggles (e.g. TA console dark/light); empty when ConciergeExperience is not mounted.
              SiteHeader and TenantShell are mutually exclusive per routing — exactly one
              #ta-theme-slot exists in the document at runtime. */}
          <span id="ta-theme-slot" className="flex items-center" />
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
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </ConversationRailContext.Provider>
  );
}
