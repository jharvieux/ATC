// #1953 — cache-key/invalidation wiring for the companion page (§23.5).
//
// pre_cruise_email_content is written in phases by
// precruise-generate-and-send.ts (a row can exist before its
// generated_content is final — e.g. the batch path updates a partial prior
// row). Caching the companion read without invalidation could serve
// placeholder/stale PII content indefinitely, so:
//
//   - the reader registers a (booking_id, phase) cache tag, and
//   - every generated_content write calls revalidateCompanionContent.
//
// Both sides derive the tag from companionContentTag — the ONE place the
// tag format lives. Drift between reader and writer tags = a permanently
// stale customer page, pinned by companion-content-cache.test.ts.
//
// Tenant isolation (D-091 #4 mindset): the cache key carries only the
// HMAC-token-derived (booking_id, phase). Token verification stays OUTSIDE
// the cached unit in the page, so nothing session- or auth-derived becomes
// shared-cacheable, and a cache entry is only reachable by presenting a
// valid token for exactly this booking+phase.

import "server-only";

import { unstable_cache, revalidateTag } from "next/cache";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

export function companionContentTag(booking_id: string, phase: string): string {
  return `precruise-companion:${booking_id}:${phase}`;
}

export interface CompanionContent {
  generated_content: Record<string, unknown>;
}

export async function getCompanionContent(
  booking_id: string,
  phase: string,
): Promise<CompanionContent | null> {
  const read = unstable_cache(
    async (): Promise<CompanionContent | null> => {
      const svc = createServiceRoleClient();
      const { data } = await svc
        // d091-allow:service-role-tenant — token-only surface (§23.5): the HMAC-verified companion token carries only (booking_id, phase); booking_id is a globally unique UUID addressing exactly one tenant's row. Same shape as the pre-#1953 read in app/companion/[token]/page.tsx.
        .from("pre_cruise_email_content")
        .select("generated_content")
        .eq("booking_id", booking_id)
        .eq("email_phase", phase)
        .maybeSingle();
      return (data as CompanionContent | null) ?? null;
    },
    ["companion-content", booking_id, phase],
    // revalidate is a safety-net TTL only — freshness is driven by the
    // write-path revalidateCompanionContent calls, including the
    // row-not-yet-written → insert transition (a cached null is purged the
    // moment the content lands).
    { tags: [companionContentTag(booking_id, phase)], revalidate: 300 },
  );
  return read();
}

/** Call after every pre_cruise_email_content generated_content write. */
export function revalidateCompanionContent(booking_id: string, phase: string): void {
  // "max" profile: purge immediately everywhere (Next 16 requires the
  // second argument); the next companion request re-reads the row.
  revalidateTag(companionContentTag(booking_id, phase), "max");
}
