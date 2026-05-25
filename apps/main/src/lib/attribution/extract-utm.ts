// BP35 §35.2 — URL UTM extractor + pending-cookie shape.
//
// Called from the middleware on every request. Returns null if the URL
// carries no UTM params AND no referrer worth recording — the middleware
// then leaves the existing pending cookie alone (it does NOT clobber
// pending attribution with an empty payload, since §35.2.2 says last-
// write-wins within a session for UTM-bearing requests only).

import { channelFromUtmMedium } from "./channel-map";
import type { AttributionPayload, AttributionPendingCookie } from "./types";

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

export type ExtractedAttribution = AttributionPendingCookie;

export function extractAttributionFromRequest(args: {
  url: URL;
  referrer: string | null;
}): ExtractedAttribution | null {
  const sp = args.url.searchParams;

  const utm_source = sp.get("utm_source");
  const utm_medium = sp.get("utm_medium");
  const utm_campaign = sp.get("utm_campaign");
  const utm_content = sp.get("utm_content");
  const utm_term = sp.get("utm_term");

  const hasUtm = UTM_KEYS.some((k) => {
    const v = sp.get(k);
    return v !== null && v.trim().length > 0;
  });

  // Per §35.2.2: only UTM-bearing requests create or overwrite pending
  // attribution. A first-visit with no UTM but a referrer doesn't.
  if (!hasUtm) return null;

  const payload: AttributionPayload = {
    utm_source: lower(utm_source),
    utm_medium: lower(utm_medium),
    utm_campaign: lower(utm_campaign),
    utm_content: lower(utm_content),
    utm_term: lower(utm_term),
    referrer_url: args.referrer ?? null,
    landing_path: args.url.pathname,
    channel: channelFromUtmMedium(utm_medium),
    manual_label: null,
    manual_category: null,
  };

  return { ...payload, captured_at: new Date().toISOString() };
}

function lower(v: string | null): string | null {
  if (!v) return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed.toLowerCase();
}
