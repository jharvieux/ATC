// Hamburger menu next to the Login button. Renders different items
// depending on whether the visitor is authenticated and whether they're
// on the platform domain or a tenant subdomain.
//
// Client component (Radix dropdown-menu needs hooks). Receives the
// pre-computed flags as props — no client-side auth lookup.

"use client";

import Link from "next/link";
import { Menu } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

export interface SiteHeaderMenuProps {
  isPlatformDomain: boolean;
  isAuthenticated: boolean;
}

export function SiteHeaderMenu({
  isPlatformDomain,
  isAuthenticated,
}: SiteHeaderMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" aria-label="Open menu" className="h-10 w-10 px-0">
          <Menu className="h-5 w-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {/* Anonymous platform marketing links — match POC top-nav contents
            in dropdown form. Find My Agent will become the quiz route in
            Phase 5; for now it points at /signup so anonymous visitors
            still have a single clear next step. */}
        {!isAuthenticated && isPlatformDomain && (
          <>
            <DropdownMenuItem asChild>
              <Link href="/signup">Find my agent</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/group">Group cruises</Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {/* Authenticated — common "Home" routes back through the
            post-login dispatcher (the / page redirects based on role). */}
        {isAuthenticated && (
          <>
            <DropdownMenuItem asChild>
              <Link href="/">Home</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/settings">Settings</Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              {/* POST is conventionally the signout method; rendering a
                  form-button keeps it semantically correct without a
                  client-side state change. */}
              <form action="/api/auth/signout" method="post">
                <button
                  type="submit"
                  className="w-full text-left"
                >
                  Sign out
                </button>
              </form>
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
