// Top-of-page chrome for the marketing, tenant, and customer-facing
// surfaces. Logo on the left, hamburger menu + Login CTA on the right.
//
// The header is INTENTIONALLY not used on /admin/*, /chat/*, or
// /onboarding/* — those surfaces have their own focused chrome (admin
// sidebar lands in Phase 4, chat redesign in Phase 5, onboarding is a
// linear funnel).
//
// Server component: takes pre-computed auth/domain flags as props rather
// than fetching itself, so callers can render it from layouts without
// chaining DB calls per page.

import Link from "next/link";
import { Logo } from "@/components/branding/Logo";
import { SiteHeaderMenu } from "./SiteHeaderMenu";
import { Button } from "@/components/ui/button";

export interface SiteHeaderProps {
  /** True when the request resolved to the platform domain (no tenant subdomain). */
  isPlatformDomain: boolean;
  /** True when the visitor has an authenticated session. */
  isAuthenticated: boolean;
}

export function SiteHeader({
  isPlatformDomain,
  isAuthenticated,
}: SiteHeaderProps) {
  return (
    <header className="w-full border-b border-border bg-background">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <Link href="/" aria-label="Home">
          <Logo height={36} />
        </Link>
        <div className="flex items-center gap-3">
          {!isAuthenticated && (
            <Button asChild className="h-9 px-3 text-sm">
              <Link href="/signup">Log in</Link>
            </Button>
          )}
          <SiteHeaderMenu
            isPlatformDomain={isPlatformDomain}
            isAuthenticated={isAuthenticated}
          />
        </div>
      </div>
    </header>
  );
}
