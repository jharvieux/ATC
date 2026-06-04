// Issue #699 — Anonymous /chat visitors on the platform domain need to
// land on a tenant subdomain so the proxy resolves a real tenant_id and
// the chat API doesn't 400 with tenant_not_resolved.
//
// Booking is ATC's own direct-customer tenant (the "prong 1" line of
// business). Anonymous prospects on ai-travelconcierge.com/chat get
// redirected to booking.ai-travelconcierge.com/chat where the full
// tenant-scoped chat works.
//
// Authenticated users with a primary tenant don't hit this path — the
// proxy (proxy.ts:275-288) already resolves their tenant on platform-
// domain chat requests. This redirect is the fall-through for everyone
// else (anonymous prospects, authenticated users with no tenant).

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";

/**
 * If the request resolved to the platform sentinel (no tenant), redirect
 * to the Booking tenant subdomain preserving the rest of the path.
 *
 * @param pathSuffix - The path AFTER `/chat`, e.g. "" for /chat or
 *                     "/marcus-cole" for /chat/marcus-cole.
 */
export async function redirectPlatformChatToBooking(pathSuffix: string): Promise<void> {
  const h = await headers();
  const tenantHeader = h.get(RESOLVED_TENANT_ID_HEADER);
  if (tenantHeader !== "platform") return;

  // The Booking tenant's slug is fixed — `booking` — and ATC owns it.
  // Construct the absolute URL because Next's `redirect()` treats a
  // relative path as same-origin, which would loop the request back
  // through the platform proxy.
  const domain = env().PLATFORM_PRIMARY_DOMAIN;
  const target = `https://booking.${domain}/chat${pathSuffix}`;
  redirect(target);
}
