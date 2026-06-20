// Hamburger menu next to the Login button. Renders different items
// depending on whether the visitor is authenticated and whether they're
// on the platform domain or a tenant subdomain.
//
// When `role` is provided (resolved tenant membership), the menu renders
// the canonical TENANT_NAV_SECTIONS for that role — same sections as the
// TenantShell hamburger at "/" so navigation is consistent across all
// tenant-area pages (Dashboard, Workspace, My account, Admin Console).
//
// Client component (Radix dropdown-menu needs hooks). Receives the
// pre-computed flags as props — no client-side auth lookup.

"use client";

import * as React from "react";
import Link from "next/link";
import Image from "next/image";
import { Menu } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { performSignout } from "@/lib/auth/perform-signout";
import { navSectionsForRole } from "@/components/tenant-shell/nav-sections";
import type { UserRole } from "@/lib/auth/permission-grants";

export interface SiteHeaderMenuProps {
  isPlatformDomain: boolean;
  isAuthenticated: boolean;
  /** Resolved tenant membership role. When present, renders role-aware nav sections. */
  role?: UserRole | null;
  /** OAuth avatar URL for the signed-in user; null for email-only accounts. */
  avatarUrl?: string | null;
  /** Display name (full_name, name, or email) for the signed-in user. */
  displayName?: string | null;
}

export function SiteHeaderMenu({
  isPlatformDomain,
  isAuthenticated,
  role = null,
  avatarUrl = null,
  displayName = null,
}: SiteHeaderMenuProps) {
  const sections = isAuthenticated && role ? navSectionsForRole(role) : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" aria-label="Open menu" className="h-10 w-10 px-0 rounded-full">
          {isAuthenticated && avatarUrl ? (
            <Image src={avatarUrl} alt="" referrerPolicy="no-referrer" width={28} height={28} className="rounded-full object-cover" />
          ) : isAuthenticated && displayName ? (
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary leading-none">
              {displayName[0]?.toUpperCase()}
            </span>
          ) : (
            <Menu className="h-5 w-5" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {/* Anonymous platform marketing links — match POC top-nav contents
            in dropdown form. */}
        {!isAuthenticated && isPlatformDomain && (
          <>
            <DropdownMenuItem asChild>
              <Link href="/agents/quiz">Find my agent</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/group">Group cruises</Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}

        {/* Authenticated on a tenant subdomain with a resolved role —
            render the same role-aware sections as the TenantShell hamburger
            so navigation is consistent whether you're at "/" or in CRM pages.
            Dashboard and Admin Console both appear here for tenant_owner. */}
        {sections && sections.map((section, i) => (
          <React.Fragment key={section.heading ?? `section-${i}`}>
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

        {/* Authenticated without a resolved role (platform domain or DB error) —
            generic fallback. #664 / #675 apply to Sign out here too. */}
        {isAuthenticated && !sections && (
          <>
            <DropdownMenuItem asChild>
              <Link href="/">Home</Link>
            </DropdownMenuItem>
            {!isPlatformDomain && (
              <DropdownMenuItem asChild>
                <Link href="/concierge">Concierge</Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem asChild>
              <Link href="/settings">Settings</Link>
            </DropdownMenuItem>
          </>
        )}

        {isAuthenticated && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/settings/profile">View profile</Link>
            </DropdownMenuItem>
            {/* onSelect (not a nested <form>) so ENTER/SPACE on the
                highlighted item fires the action without a page reload (#664). */}
            <DropdownMenuItem onSelect={performSignout}>
              Sign out
            </DropdownMenuItem>
          </>
        )}

        {!isAuthenticated && (
          <DropdownMenuItem asChild>
            <Link href="/signup">Sign up</Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
