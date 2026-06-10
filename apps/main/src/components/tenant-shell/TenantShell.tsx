"use client";

// #962 — Landing shell for authenticated SaaS users at the tenant
// subdomain root. Left = collapsible role-filtered nav, right = the
// default panel (the embedded support chat, passed as children by the
// server page). Top bar: sidebar toggle + logo on the left, hamburger
// menu (View profile / Admin / Sign out) on the right.
//
// Mirrors the AdminShell/AdminSidebar chrome so the two app shells stay
// visually consistent. Client component for the toggle + dropdown state;
// role is resolved server-side in app/page.tsx and passed down — no
// client-side auth lookup.

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, PanelLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/branding/Logo";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { performSignout } from "@/lib/auth/perform-signout";
import { isActiveLink } from "@/components/admin-shell/is-active-link";
import { navSectionsForRole } from "./nav-sections";
import type { UserRole } from "@/lib/auth/permission-grants";

export interface TenantShellProps {
  role: UserRole;
  children: React.ReactNode;
}

export function TenantShell({
  role,
  children,
}: Readonly<TenantShellProps>): React.ReactElement {
  // null = the visitor hasn't toggled yet → CSS-only default (closed
  // below lg, open on lg+). The default can't live in useState because
  // the viewport width is unknown during SSR; encoding it as Tailwind
  // breakpoint classes keeps the first paint correct on both form
  // factors with no hydration flash.
  const [open, setOpen] = React.useState<boolean | null>(null);
  const pathname = usePathname();
  const sections = navSectionsForRole(role);

  const toggle = (): void =>
    setOpen((prev) =>
      prev === null
        ? !window.matchMedia("(min-width: 1024px)").matches
        : !prev,
    );

  return (
    <div className="flex h-screen flex-col">
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
          <Link href="/" aria-label="Home">
            <Logo height={49} />
          </Link>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              aria-label="Open menu"
              className="h-10 w-10 px-0"
            >
              <Menu className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem asChild>
              <Link href="/settings/profile">View profile</Link>
            </DropdownMenuItem>
            {role === "tenant_owner" && (
              <DropdownMenuItem asChild>
                <Link href="/settings">Admin</Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {/* onSelect (not a nested <form>) so ENTER/SPACE on the
                highlighted item fire the action — see SiteHeaderMenu (#664). */}
            <DropdownMenuItem onSelect={performSignout}>
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            "shrink-0 overflow-y-auto overflow-x-hidden border-r border-border bg-background transition-all",
            open === null ? "w-0 lg:w-64" : open ? "w-64" : "w-0",
          )}
        >
          {/* Fixed w-64 inner column so link text doesn't reflow while the
              aside width animates. */}
          <nav className="flex w-64 flex-col gap-4 px-3 py-6">
            {sections.map((section) => (
              <div key={section.heading ?? "top"}>
                {section.heading && (
                  <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {section.heading}
                  </div>
                )}
                <ul className="mt-1 flex flex-col gap-0.5">
                  {section.items.map((item) => {
                    const active = isActiveLink(pathname, item.href);
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
              </div>
            ))}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
