// BP35 §35.6 — Quote/booking conversion-touch population.
//
// Called from quote creation + booking creation handlers right after
// the row is inserted. Reads the contact's most recent
// attribution_touches row and copies its values to the row's
// conversion_touch_* columns. Falls back to the contact's first_touch_*
// if no touch rows exist (legacy contacts predating BP35).

import type { SupabaseClient } from "@supabase/supabase-js";

const ATTR_COLUMNS = [
  "source_origin",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "referrer_url",
  "landing_path",
  "channel",
  "manual_label",
  "manual_category",
] as const;

export async function populateConversionTouch(args: {
  tenant_id: string;
  contact_id: string;
  target_table: "quotes" | "bookings";
  target_id: string;
  svc: Pick<SupabaseClient, "from">;
}): Promise<{ ok: true; source: "touch_table" | "contact_first_touch" | "none" } | { ok: false; error: string }> {
  const { tenant_id, contact_id, target_table, target_id, svc } = args;

  // Prefer the rolling table — that's the §35.6.2 spec rule: "fresh from
  // the contact's current most recent touch".
  const { data: touchData } = await svc
    .from("attribution_touches")
    .select(
      "occurred_at, source_origin, utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer_url, landing_path, channel, manual_label, manual_category",
    )
    .eq("tenant_id", tenant_id)
    .eq("contact_id", contact_id)
    .order("occurred_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (touchData) {
    const update = buildConversionUpdate(touchData as Record<string, unknown>);
    const { error } = await svc.from(target_table).update(update).eq("id", target_id);
    if (error) return { ok: false, error: `conv_update_failed:${error.message}` };
    return { ok: true, source: "touch_table" };
  }

  // No touch row — fall back to the contact's first_touch_* values.
  const { data: contactData } = await svc
    .from("contacts")
    .select(
      "first_touch_at, first_touch_source_origin, first_touch_utm_source, first_touch_utm_medium, first_touch_utm_campaign, first_touch_utm_content, first_touch_utm_term, first_touch_referrer_url, first_touch_landing_path, first_touch_channel, first_touch_manual_label, first_touch_manual_category",
    )
    .eq("id", contact_id)
    .maybeSingle();

  if (!contactData || !(contactData as { first_touch_at?: string | null }).first_touch_at) {
    // No attribution at all — leave the row's conversion_touch_* NULL.
    return { ok: true, source: "none" };
  }

  const c = contactData as Record<string, unknown>;
  const update: Record<string, unknown> = {
    conversion_touch_at: c.first_touch_at,
    conversion_touch_source_origin: c.first_touch_source_origin,
    conversion_touch_utm_source: c.first_touch_utm_source,
    conversion_touch_utm_medium: c.first_touch_utm_medium,
    conversion_touch_utm_campaign: c.first_touch_utm_campaign,
    conversion_touch_utm_content: c.first_touch_utm_content,
    conversion_touch_utm_term: c.first_touch_utm_term,
    conversion_touch_referrer_url: c.first_touch_referrer_url,
    conversion_touch_landing_path: c.first_touch_landing_path,
    conversion_touch_channel: c.first_touch_channel,
    conversion_touch_manual_label: c.first_touch_manual_label,
    conversion_touch_manual_category: c.first_touch_manual_category,
  };
  const { error } = await svc.from(target_table).update(update).eq("id", target_id);
  if (error) return { ok: false, error: `conv_update_failed:${error.message}` };
  return { ok: true, source: "contact_first_touch" };
}

function buildConversionUpdate(row: Record<string, unknown>): Record<string, unknown> {
  const update: Record<string, unknown> = {
    conversion_touch_at: row.occurred_at,
  };
  for (const col of ATTR_COLUMNS) {
    update[`conversion_touch_${col}`] = row[col] ?? null;
  }
  return update;
}
