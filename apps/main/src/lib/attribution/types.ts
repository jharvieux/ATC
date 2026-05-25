// BP35 §35 — Shared attribution types.

export type SourceOrigin = "utm_parsed" | "agent_set" | "agent_edit" | "imported";

// The shape of a touch as it lives in attribution_touches + first_touch_*
// (without the source_origin since first_touch can't be 'agent_edit').
export interface AttributionPayload {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  referrer_url: string | null;
  landing_path: string | null;
  channel: string | null;
  manual_label: string | null;
  manual_category: string | null;
}

export interface AttributionPendingCookie extends AttributionPayload {
  captured_at: string; // ISO timestamp
}

// All-null payload used for direct visits when an identification happens
// without any pending attribution in session.
export function emptyAttributionPayload(): AttributionPayload {
  return {
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    referrer_url: null,
    landing_path: null,
    channel: "direct",
    manual_label: null,
    manual_category: null,
  };
}
