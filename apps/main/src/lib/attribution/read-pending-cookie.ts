// BP35 §35.2.2 — Helper for identification handlers to read + clear the
// pending attribution cookie set by middleware.
//
// Returns the parsed payload (or null if no cookie or malformed), and
// the response writer should clear the cookie after a successful touch
// write so a stale UTM doesn't get attached to a future identification.

import type { NextResponse } from "next/server";
import type { AttributionPendingCookie } from "./types";

export const ATTRIBUTION_PENDING_COOKIE = "atc_attribution_pending";

// Server actions / route handlers — also support standard Request cookies.
export function readPendingAttributionFromHeader(cookieHeader: string | null): AttributionPendingCookie | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(/;\s*/).find((c) => c.startsWith(`${ATTRIBUTION_PENDING_COOKIE}=`));
  if (!match) return null;
  const raw = match.slice(ATTRIBUTION_PENDING_COOKIE.length + 1);
  try {
    return JSON.parse(decodeURIComponent(raw)) as AttributionPendingCookie;
  } catch {
    return null;
  }
}

export function clearPendingAttributionCookie(res: NextResponse): void {
  res.cookies.delete(ATTRIBUTION_PENDING_COOKIE);
}
