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

import React from "react";
import Link from "next/link";
import { BrandLogo, type BrandLogoBranding } from "@/components/branding/BrandLogo";
import { SiteHeaderMenu } from "./SiteHeaderMenu";
import { Button } from "@/components/ui/button";
import type { UserRole } from "@/lib/auth/permission-grants";

export interface SiteHeaderProps {
  /** True when the request resolved to the platform domain (no tenant subdomain). */
  isPlatformDomain: boolean;
  /** True when the visitor has an authenticated session. */
  isAuthenticated: boolean;
  /** Tenant logo/name for tenant subdomains (§16); null shows the platform logo. */
  tenantBranding: BrandLogoBranding | null;
  /** Resolved tenant membership role; null for anonymous visitors, platform domain, or DB error. */
  role?: UserRole | null;
  /** Optional element rendered to the left of the logo (e.g. conversation rail toggle for staff). */
  leftSlot?: React.ReactNode;
}

export function SiteHeader({
  isPlatformDomain,
  isAuthenticated,
  tenantBranding,
  role = null,
  leftSlot,
}: SiteHeaderProps) {
  return (
    <header className="w-full border-b border-border bg-background">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          {leftSlot}
          <Link href="/" aria-label="Home">
            <BrandLogo branding={tenantBranding} height={63} />
          </Link>
        </div>
        <div className="flex items-center gap-3">
          {!isAuthenticated && (
            <Button asChild className="h-9 px-3 text-sm">
              <Link href="/signup">Log in</Link>
            </Button>
          )}
          <SiteHeaderMenu
            isPlatformDomain={isPlatformDomain}
            isAuthenticated={isAuthenticated}
            role={role}
          />
        </div>
      </div>
    </header>
  );
}
