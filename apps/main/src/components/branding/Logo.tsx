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
  /**
   * When true the logo renders with empty alt so screen readers skip it.
   * Use this when an adjacent visible element already announces the brand
   * (a wordmark, a hero heading) — otherwise SRs read the brand twice (#672).
   */
  decorative?: boolean;
}

// The bundled horizontal SVG has viewBox 1118×220 so aspect-ratio is
// fixed. Setting it on `<img>` style lets the browser reserve the
// correct width BEFORE the SVG response arrives — without it the span
// renders 0px wide and surrounding content shifts when the asset lands
// (#671). Encoded as a constant so a future SVG change has one source
// of truth.
const HORIZONTAL_ASPECT_RATIO = "1118 / 220";

export function Logo({
  className,
  height = 32,
  decorative = false,
}: LogoProps): React.ReactElement {
  const style = { height, aspectRatio: HORIZONTAL_ASPECT_RATIO };
  const alt = decorative ? "" : "AI Travel Concierge";
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center" }}>
      <img
        src="/brand/logo-horizontal.svg"
        alt={alt}
        style={style}
        className="block dark:hidden w-auto"
      />
      <img
        src="/brand/logo-horizontal-reverse.svg"
        alt={alt}
        style={style}
        className="hidden dark:block w-auto"
      />
    </span>
  );
}
