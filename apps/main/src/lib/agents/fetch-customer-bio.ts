// Public-page read of personas.customer_bio (the third-person marketing
// bio for a named agent). Used by /agents/[slug] to surface the bio
// platform admins author through /admin/personas without a code deploy.
//
// Why service-role: RLS on personas restricts SELECT to authenticated
// users — anonymous visitors hitting /agents/[slug] (a public marketing
// page) can't satisfy that. The field we read is intentionally
// public-marketing content. Read-only.

import "server-only";

import { createServiceRoleClient } from "@/lib/db/service-role-client";

/**
 * Fetch the customer-facing bio for a persona by slug. Returns null if
 * the persona doesn't exist, is inactive, or has no customer_bio yet —
 * callers fall back to the in-code catalog bio.
 */
export async function fetchPersonaCustomerBio(slug: string): Promise<string | null> {
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("personas")
    .select("customer_bio, is_active")
    .eq("slug", slug)
    .maybeSingle();

  // `.maybeSingle()` returns `{ data: null, error: null }` for zero rows.
  // Anything in `error` is a real DB/network failure — surface as 500
  // instead of silently degrading to the catalog bio.
  if (error) throw new Error(`fetchPersonaCustomerBio: ${error.message}`);
  if (!data || !data.is_active) return null;
  return data.customer_bio?.trim() ? data.customer_bio : null;
}
