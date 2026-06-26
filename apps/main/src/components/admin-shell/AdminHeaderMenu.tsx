// Cross-area navigation hamburger for the platform-admin shell header.
// Mirrors the SiteHeaderMenu trigger (avatar → initials → Menu icon) and
// renders the standard tenant_owner nav sections so navigation is consistent
// across the admin and console surfaces.
//
// Client component (dropdown state). No auth lookup here — AdminShell renders
// only after (admin)/layout.tsx has already verified platform-admin access.

"use client";

import * as React from "react";
import Link from "next/link";
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
import { hamburgerSectionsForRole } from "@/components/tenant-shell/nav-sections";

export interface AdminHeaderMenuProps {
  avatarUrl?: string | null;
  displayName?: string | null;
}

const STAFF_SECTIONS = hamburgerSectionsForRole("tenant_owner");

export function AdminHeaderMenu({
  avatarUrl = null,
  displayName = null,
}: AdminHeaderMenuProps): React.ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" aria-label="Open navigation menu" className="h-10 w-10 px-0 rounded-full">
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
        {STAFF_SECTIONS.map((section, i) => (
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

        {/* No separator — CRM groups with Admin Console (both tenant-console nav). */}
        <DropdownMenuItem asChild>
          <Link href="/crm/contacts">CRM</Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <Link href="/admin">Platform Admin</Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <Link href="/settings/profile">View profile</Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={performSignout}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
