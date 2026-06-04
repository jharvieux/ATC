// Full horizontal AI Travel Concierge logo. Theme-aware: light variant in
// light mode, reverse (light-on-dark) variant in dark mode. The swap is
// driven by the `.dark` class that next-themes sets on <html> pre-hydration,
// so there's no theme flash.
//
// Why <img> instead of next/image: the asset is a static SVG served from
// /public — next/image's optimization (resize, format conversion) doesn't
// apply to SVG, and enabling it requires `dangerouslyAllowSVG` in
// next.config which we don't want for security. Matches the existing
// emails/* convention for static SVG/branding assets.

/* eslint-disable @next/next/no-img-element */

import * as React from "react";

export interface LogoProps {
  className?: string;
  /** Pixel height of the logo. Width auto-scales to preserve aspect ratio. */
  height?: number;
}

export function Logo({ className, height = 32 }: LogoProps): React.ReactElement {
  const style = { height };
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center" }}>
      <img
        src="/brand/logo-horizontal.svg"
        alt="AI Travel Concierge"
        style={style}
        className="block dark:hidden w-auto"
      />
      <img
        src="/brand/logo-horizontal-reverse.svg"
        alt="AI Travel Concierge"
        style={style}
        className="hidden dark:block w-auto"
      />
    </span>
  );
}
