// Tenant-or-platform logo for page chrome (§16): renders the tenant's
// uploaded logo (light/dark pair, same pattern as the landing hero) when
// one is set, otherwise the platform Logo. Plain presentational component
// so both server (SiteHeader) and client (TenantShell) chrome can use it.
/* eslint-disable @next/next/no-img-element */

import * as React from "react";
import { Logo } from "@/components/branding/Logo";

export interface BrandLogoBranding {
  logo_url: string | null;
  logo_dark_url: string | null;
  display_name: string;
}

export interface BrandLogoProps {
  branding: BrandLogoBranding | null;
  /** Pixel height, matching the Logo fallback's height prop. */
  height: number;
}

export function BrandLogo({ branding, height }: BrandLogoProps): React.ReactElement {
  if (!branding?.logo_url) return <Logo height={height} />;
  return (
    <span className="inline-flex items-center">
      <img
        src={branding.logo_url}
        alt={branding.display_name}
        style={{ height }}
        className="w-auto block dark:hidden"
      />
      <img
        src={branding.logo_dark_url ?? branding.logo_url}
        alt={branding.display_name}
        style={{ height }}
        className="w-auto hidden dark:block"
      />
    </span>
  );
}
