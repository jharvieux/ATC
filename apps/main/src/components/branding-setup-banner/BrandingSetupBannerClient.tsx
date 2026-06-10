"use client";

// Dismissible amber banner shown to tenant_owner members whose workspace
// has no logo configured yet. Dismiss state is stored in localStorage
// (tenant-scoped key) so a dismissed banner stays dismissed across
// navigations without a DB write.
//
// The banner intentionally starts hidden (dismissed=true) and transitions
// to visible in useEffect once the localStorage check runs — this avoids
// a flash where the banner appears then disappears on a browser where the
// user already dismissed it.

import { useState, useEffect } from "react";
import Link from "next/link";

export interface BrandingSetupBannerClientProps {
  tenantId: string;
}

/**
 * Produces the localStorage key used to track per-tenant dismiss state.
 * Exported as a named export so unit tests can assert the key format
 * without needing a DOM — guards against a future refactor accidentally
 * collapsing all tenants to a single key (which would hide the banner
 * for all tenants when any one dismisses it).
 */
export function brandingSetupDismissedKey(tenantId: string): string {
  return `branding-setup-dismissed-${tenantId}`;
}

export function BrandingSetupBannerClient({
  tenantId,
}: BrandingSetupBannerClientProps) {
  // Start dismissed so there is no server/client mismatch on first render.
  // The useEffect below flips this to false when the user hasn't dismissed.
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (!localStorage.getItem(brandingSetupDismissedKey(tenantId))) {
      setDismissed(false);
    }
  }, [tenantId]);

  if (dismissed) return null;

  function handleDismiss() {
    localStorage.setItem(brandingSetupDismissedKey(tenantId), "1");
    setDismissed(true);
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full bg-amber-50 border-b border-amber-200 px-6 py-3"
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
        <p className="text-sm text-amber-900">
          Your workspace branding is not set up yet &mdash; logo, colors, and
          agency info help build trust with your clients.{" "}
          <Link
            href="/settings/branding"
            className="font-medium underline underline-offset-2 hover:no-underline"
          >
            Set up branding &rarr;
          </Link>
        </p>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss branding setup reminder"
          className="shrink-0 text-amber-700 hover:text-amber-900 text-lg leading-none"
        >
          &times;
        </button>
      </div>
    </div>
  );
}
