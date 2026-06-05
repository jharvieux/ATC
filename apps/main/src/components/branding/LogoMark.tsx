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

import * as React from "react";

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
        <defs>
          <linearGradient id={seaGradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5DADE2" />
            <stop offset="100%" stopColor="#0A2342" />
          </linearGradient>
          <linearGradient id={horizonId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#5DADE2" stopOpacity="0.4" />
            <stop offset="50%" stopColor="#0A2342" />
            <stop offset="100%" stopColor="#5DADE2" stopOpacity="0.4" />
          </linearGradient>
          <clipPath id={clipId}>
            <circle cx="170" cy="180" r="130" />
          </clipPath>
        </defs>

        {/* Light variant */}
        <g className="dark:hidden">
          <circle cx="170" cy="180" r="130" fill="none" stroke="#0A2342" strokeOpacity="0.12" strokeWidth="1" />
          <g clipPath={`url(#${clipId})`}>
            <rect x="40" y="50" width="260" height="260" fill={`url(#${seaGradId})`} opacity="0.06" />
            <g fill="#0A2342" opacity="0.18">
              <circle cx="80" cy="240" r="1.4" />
              <circle cx="120" cy="260" r="1.4" />
              <circle cx="160" cy="280" r="1.4" />
              <circle cx="210" cy="255" r="1.4" />
              <circle cx="250" cy="235" r="1.4" />
              <circle cx="100" cy="280" r="1.4" />
              <circle cx="190" cy="290" r="1.4" />
              <circle cx="230" cy="270" r="1.4" />
              <circle cx="140" cy="225" r="1.2" />
              <circle cx="180" cy="245" r="1.2" />
              <circle cx="220" cy="215" r="1.2" />
            </g>
            <g stroke="#0A2342" strokeOpacity="0.14" strokeWidth="0.6" fill="none">
              <path d="M80 240 L120 260 L160 280 L210 255 L250 235" />
              <path d="M100 280 L160 280 L190 290 L230 270" />
              <path d="M140 225 L180 245 L220 215" />
              <path d="M120 260 L140 225" />
              <path d="M210 255 L220 215" />
              <path d="M160 280 L180 245" />
            </g>
            <path d="M40 200 Q 170 178 300 200" fill="none" stroke={`url(#${horizonId})`} strokeWidth="1.6" strokeLinecap="round" />
            <path d="M40 200 Q 170 178 300 200 L 300 220 Q 170 198 40 220 Z" fill="#5DADE2" opacity="0.06" />
            <path d="M40 215 Q 170 193 300 215" fill="none" stroke="#5DADE2" strokeWidth="0.6" strokeOpacity="0.35" />
          </g>
          <g transform="translate(170 180)">
            <path d="M-22 -2 L 22 -2 L 17 6 L -17 6 Z" fill="#0A2342" />
            <rect x="-0.6" y="-26" width="1.2" height="24" fill="#0A2342" />
            <path d="M0 -26 L 12 -6 L 0 -6 Z" fill="#0A2342" />
            <path d="M0 -26 L -10 -6 L 0 -6 Z" fill="#5DADE2" />
            <path d="M0 -26 L 4 -28 L 0 -30 Z" fill="#0A2342" />
          </g>
        </g>

        {/* Reverse (dark-mode) variant */}
        <g className="hidden dark:block">
          <circle cx="170" cy="180" r="130" fill="none" stroke="#ffffff" strokeOpacity="0.18" strokeWidth="1" />
          <g clipPath={`url(#${clipId})`}>
            <g fill="#ffffff" opacity="0.22">
              <circle cx="80" cy="240" r="1.4" />
              <circle cx="120" cy="260" r="1.4" />
              <circle cx="160" cy="280" r="1.4" />
              <circle cx="210" cy="255" r="1.4" />
              <circle cx="250" cy="235" r="1.4" />
              <circle cx="100" cy="280" r="1.4" />
              <circle cx="190" cy="290" r="1.4" />
              <circle cx="230" cy="270" r="1.4" />
              <circle cx="140" cy="225" r="1.2" />
              <circle cx="180" cy="245" r="1.2" />
              <circle cx="220" cy="215" r="1.2" />
            </g>
            <g stroke="#ffffff" strokeOpacity="0.18" strokeWidth="0.6" fill="none">
              <path d="M80 240 L120 260 L160 280 L210 255 L250 235" />
              <path d="M100 280 L160 280 L190 290 L230 270" />
              <path d="M140 225 L180 245 L220 215" />
              <path d="M120 260 L140 225" />
              <path d="M210 255 L220 215" />
              <path d="M160 280 L180 245" />
            </g>
            <path d="M40 200 Q 170 178 300 200" fill="none" stroke="#5DADE2" strokeWidth="1.8" strokeLinecap="round" />
          </g>
          <g transform="translate(170 180)">
            <path d="M-22 -2 L 22 -2 L 17 6 L -17 6 Z" fill="#ffffff" />
            <rect x="-0.6" y="-26" width="1.2" height="24" fill="#ffffff" />
            <path d="M0 -26 L 12 -6 L 0 -6 Z" fill="#ffffff" />
            <path d="M0 -26 L -10 -6 L 0 -6 Z" fill="#5DADE2" />
            <path d="M0 -26 L 4 -28 L 0 -30 Z" fill="#ffffff" />
          </g>
        </g>
      </svg>
    </span>
  );
}
