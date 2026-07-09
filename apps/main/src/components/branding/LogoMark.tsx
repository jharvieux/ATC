// Square AI Travel Concierge logo mark (icon-only, no wordmark). For tight
// spaces — favicons, mobile nav, condensed admin chrome. Theme-aware via
// the .dark class that next-themes sets on <html> pre-hydration, so no
// theme flash.
//
// Why inline SVG instead of <img src="/brand/...">:
// The prior <img>-based implementation eagerly fetched BOTH theme variants
// on every page load (~5KB combined for the mark) regardless of which was
// shown — browsers don't honor display:none for prefetch (#670). Inlining
// ships the geometry in the HTML payload (gzip dedupes most of the
// identical shape data between light + reverse), avoids two HTTP requests,
// and removes the dependency on the asset cache being warm.
//
// Why one <svg> with shared <defs> instead of two: prevents duplicate-ID
// gradients/clipPaths in the DOM when both variants are present. Tailwind
// classes on the inner <g> wrappers toggle visibility.
//
// IDs are namespaced via React.useId() so multiple LogoMark instances on
// the same page (e.g. nav + footer) don't alias their <defs>. useId is
// RSC-safe.
//
// Geometry shared with Logo.tsx via compass-mark.tsx (#1610).

import * as React from "react";
import { CompassMarkDefs, CompassMarkLight, CompassMarkDark } from "./compass-mark";

export interface LogoMarkProps {
  className?: string;
  /** Pixel size (both width and height). The mark is a square. */
  size?: number;
}

export function LogoMark({ className, size = 32 }: LogoMarkProps): React.ReactElement {
  const id = React.useId();
  const seaGradId = `${id}-sea`;
  const horizonId = `${id}-horizon`;
  const clipId = `${id}-clip`;
  return (
    <span className={className} style={{ display: "inline-flex" }}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="30 40 280 280"
        width={size}
        height={size}
        role="img"
        aria-label="AI Travel Concierge"
      >
        <CompassMarkDefs seaGradId={seaGradId} horizonId={horizonId} clipId={clipId} />

        {/* Light variant */}
        <g className="dark:hidden">
          <CompassMarkLight seaGradId={seaGradId} horizonId={horizonId} clipId={clipId} />
        </g>

        {/* Reverse (dark-mode) variant */}
        <g className="hidden dark:block">
          <CompassMarkDark clipId={clipId} />
        </g>
      </svg>
    </span>
  );
}
