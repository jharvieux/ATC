// §38.8.1 / §39.5 — Resolve a customer-facing access token to the
// resource + tenant for the public chat endpoint.
//
// Tries quotes.customer_access_token first, then trip_itineraries.access_token.
// Returns null if the token doesn't match any resource. Caller is
// responsible for tenant-scoped follow-up reads using the returned
// tenant_id.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ResolvedPublicToken =
  | { kind: "quote"; quote_id: string; tenant_id: string; status: string }
  | { kind: "trip_itinerary"; itinerary_id: string; booking_id: string; tenant_id: string; status: string };

export async function resolvePublicToken(
  db: SupabaseClient,
  token: string,
): Promise<ResolvedPublicToken | null> {
  if (!token || token.length < 16 || token.length > 256) return null;

  const { data: quoteData } = await db
    .from("quotes")
    .select("id, tenant_id, status")
    .eq("customer_access_token", token)
    .maybeSingle();
  if (quoteData) {
    const q = quoteData as { id: string; tenant_id: string; status: string };
    return { kind: "quote", quote_id: q.id, tenant_id: q.tenant_id, status: q.status };
  }

  const { data: itinData } = await db
    .from("trip_itineraries")
    .select("id, booking_id, tenant_id, status")
    .eq("access_token", token)
    .maybeSingle();
  if (itinData) {
    const it = itinData as { id: string; booking_id: string; tenant_id: string; status: string };
    return {
      kind: "trip_itinerary",
      itinerary_id: it.id,
      booking_id: it.booking_id,
      tenant_id: it.tenant_id,
      status: it.status,
    };
  }

  return null;
}

// F-tok-02 (#1382) — a resolved token alone is not enough to load customer PII
// into an LLM conversation: the resource must be in a customer-viewable state.
// The public chat route loads cruise/ship/cabin/price/agent_notes context as
// soon as a token resolves, so a declined/expired/accepted quote or an archived
// itinerary token (forwarded or leaked) would otherwise re-expose that PII.
// Mirrors the allowlist the sibling quote-select route enforces.
//   quotes:          'draft','sent','viewed','accepted','declined','expired','converted' → only sent/viewed
//   trip_itineraries:'draft','sent','archived'                                            → only sent
export function isPublicTokenViewable(resolved: ResolvedPublicToken): boolean {
  if (resolved.kind === "quote") {
    return resolved.status === "sent" || resolved.status === "viewed";
  }
  return resolved.status === "sent";
}
