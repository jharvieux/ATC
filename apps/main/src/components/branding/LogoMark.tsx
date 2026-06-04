// Square AI Travel Concierge logo mark (icon-only, no wordmark). For tight
// spaces — favicons, mobile nav, condensed admin chrome. Theme-aware via
// the same .dark-class swap as the full Logo. See Logo.tsx for the
// next/image vs <img> rationale.

/* eslint-disable @next/next/no-img-element */

import * as React from "react";

export interface LogoMarkProps {
  className?: string;
  /** Pixel size (both width and height). The mark is a square. */
  size?: number;
}

export function LogoMark({ className, size = 32 }: LogoMarkProps): React.ReactElement {
  const style = { width: size, height: size };
  return (
    <span className={className} style={{ display: "inline-flex" }}>
      <img
        src="/brand/logo-mark.svg"
        alt="AI Travel Concierge"
        style={style}
        className="block dark:hidden"
      />
      <img
        src="/brand/logo-mark-reverse.svg"
        alt="AI Travel Concierge"
        style={style}
        className="hidden dark:block"
      />
    </span>
  );
}
