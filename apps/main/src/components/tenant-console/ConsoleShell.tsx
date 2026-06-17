// Layout shell for every page in the (console) route group — the tenant
// Admin Console. Two columns: left = ConsoleSidebar (collapsible groupings
// of console pages), right = page content. Slim top bar: sidebar toggle +
// platform logo on the left, hamburger menu (Dashboard / View profile /
// Sign out) on the right.
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
import { Menu, PanelLeft } from "lucide-react";
import { Logo } from "@/components/branding/Logo";
import { LogoMark } from "@/components/branding/LogoMark";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { performSignout } from "@/lib/auth/perform-signout";
import { ConsoleSidebar } from "./ConsoleSidebar";
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

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border bg-background px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={toggle}
            aria-label="Toggle navigation"
            className="rounded-md p-1.5 hover:bg-accent"
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
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Admin Console
            </span>
          </Link>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" aria-label="Open menu" className="h-10 w-10 px-0">
              <Menu className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem asChild>
              <Link href="/">Dashboard</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/settings/profile">View profile</Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* onSelect (not a nested <form>) so ENTER/SPACE on the
                highlighted item fire the action — see SiteHeaderMenu (#664). */}
            <DropdownMenuItem onSelect={performSignout}>Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className="flex min-h-0 flex-1">
        <ConsoleSidebar open={open} initialCollapsed={initialCollapsed} role={role} />
        <main className="min-w-0 flex-1 overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
