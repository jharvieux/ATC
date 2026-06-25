// Cross-area navigation hamburger for the platform-admin shell header.
// Two sections — Tenant Console (/settings/*) and Platform Admin (/admin/*) —
// so a user who holds both roles can jump between surfaces without going back
// to the root. Sign out at the bottom.
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

export function AdminHeaderMenu(): React.ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" aria-label="Open navigation menu" className="h-10 w-10 px-0 rounded-full">
          <Menu className="h-5 w-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Tenant Console</DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <Link href="/settings">Admin Console</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/crm/contacts">CRM</Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuLabel>Platform Admin</DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <Link href="/admin">Platform Admin</Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={performSignout}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
