// BP35 §35.4 — Touch writer.
//
// Called from contact identification points (signup, chat start, form
// submission, manual entry, import-acceptance). Writes an
// attribution_touches row and, if the contact was just created, also
// populates the contact's first_touch_* columns.

import type { SupabaseClient } from "@supabase/supabase-js";
import { channelFromManualCategory } from "./channel-map";
import { emptyAttributionPayload, type AttributionPayload, type SourceOrigin } from "./types";

export type RecordTouchInput = {
  tenant_id: string;
  contact_id: string;
  is_new_contact: boolean;
  source_origin: SourceOrigin;
  payload: AttributionPayload | null;
  editor_user_id?: string | null;
  // Override occurred_at (otherwise NOW). Useful for backfills / imports
  // that want to attribute to the moment the source document was created.
  occurred_at?: string | null;
};

export async function recordIdentificationTouch(
  input: RecordTouchInput,
  svc: Pick<SupabaseClient, "from">,
): Promise<{ ok: true; touch_id: string } | { ok: false; error: string }> {
  const payload = normalisePayload(input);

  const { data: inserted, error: insertErr } = await svc
    .from("attribution_touches")
    .insert({
      tenant_id: input.tenant_id,
      contact_id: input.contact_id,
      source_origin: input.source_origin,
      occurred_at: input.occurred_at ?? new Date().toISOString(),
      utm_source: payload.utm_source,
      utm_medium: payload.utm_medium,
      utm_campaign: payload.utm_campaign,
      utm_content: payload.utm_content,
      utm_term: payload.utm_term,
      referrer_url: payload.referrer_url,
      landing_path: payload.landing_path,
      channel: payload.channel,
      manual_label: payload.manual_label,
      manual_category: payload.manual_category,
      editor_user_id: input.editor_user_id ?? null,
    })
    .select("id")
    .single();
  if (insertErr || !inserted) {
    return { ok: false, error: `touch_insert_failed: ${insertErr?.message ?? "unknown"}` };
  }

  // §35.4.3 — populate first_touch_* only on contact creation. Returning
  // visits with new UTM (is_new_contact=false) write a touch row but
  // leave first_touch_* untouched.
  if (input.is_new_contact) {
    if (input.source_origin === "agent_edit") {
      // agent_edit cannot apply to a brand-new contact (no prior touch
      // to edit). Caller bug — fail loudly.
      return { ok: false, error: "agent_edit_on_new_contact" };
    }
    const firstTouchOrigin = input.source_origin; // 'utm_parsed' | 'agent_set' | 'imported'
    const { error: updateErr } = await svc
      .from("contacts")
      .update({
        first_touch_at: input.occurred_at ?? new Date().toISOString(),
        first_touch_source_origin: firstTouchOrigin,
        first_touch_utm_source: payload.utm_source,
        first_touch_utm_medium: payload.utm_medium,
        first_touch_utm_campaign: payload.utm_campaign,
        first_touch_utm_content: payload.utm_content,
        first_touch_utm_term: payload.utm_term,
        first_touch_referrer_url: payload.referrer_url,
        first_touch_landing_path: payload.landing_path,
        first_touch_channel: payload.channel,
        first_touch_manual_label: payload.manual_label,
        first_touch_manual_category: payload.manual_category,
      })
      .eq("id", input.contact_id);
    if (updateErr) {
      return { ok: false, error: `first_touch_update_failed: ${updateErr.message}` };
    }
  }

  return { ok: true, touch_id: (inserted as { id: string }).id };
}

function normalisePayload(input: RecordTouchInput): AttributionPayload {
  // No pending attribution + agent_set / imported path: derive a payload
  // from manual fields if provided; otherwise treat as direct.
  if (input.payload) {
    const p = { ...input.payload };
    if (!p.channel) {
      if (input.source_origin === "agent_set" || input.source_origin === "imported" || input.source_origin === "agent_edit") {
        p.channel = channelFromManualCategory(p.manual_category);
      } else {
        p.channel = "direct";
      }
    }
    return p;
  }
  return emptyAttributionPayload();
}
