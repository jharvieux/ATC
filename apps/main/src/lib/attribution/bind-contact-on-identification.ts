// BP35 §35.2.2 — Centralized "user just identified themselves" binding.
//
// Two call sites:
//   - transfer-finalize Inngest (anonymous chat → identified user; §11.6)
//   - signup completion (when that route is built; currently §7.1 stub)
//
// Looks up the existing CRM contact for (tenant_id, user_id). If one
// exists, just records a touch (is_new_contact=false). If none exists,
// creates a minimal contact row (first_name/last_name from users) and
// records a first-touch.
//
// Pending attribution comes from the cookie when the caller has a
// Request; for Inngest paths (transfer-finalize), the cookie is not
// available — we default to direct/empty attribution. The reverse-
// engineering of the original UTM is not possible after the cookie
// has rotated, so we accept that anonymous→identified transfers that
// happen days later attribute as 'direct'.

import type { SupabaseClient } from "@supabase/supabase-js";
import { recordIdentificationTouch } from "./record-touch";
import type { AttributionPayload, SourceOrigin } from "./types";

export type BindResult =
  | { ok: true; contact_id: string; was_new_contact: boolean }
  | { ok: false; error: string };

export async function bindContactOnIdentification(args: {
  svc: Pick<SupabaseClient, "from">;
  tenant_id: string;
  user_id: string;
  source_origin: SourceOrigin;
  pending_payload?: AttributionPayload | null;
}): Promise<BindResult> {
  const { svc, tenant_id, user_id, source_origin, pending_payload } = args;

  const { data: existing } = await svc
    .from("contacts")
    .select("id")
    .eq("tenant_id", tenant_id)
    .eq("user_id", user_id)
    .maybeSingle();

  if (existing) {
    const contactId = (existing as { id: string }).id;
    const touch = await recordIdentificationTouch(
      {
        tenant_id,
        contact_id: contactId,
        is_new_contact: false,
        source_origin: source_origin === "agent_set" ? "agent_set" : source_origin,
        payload: pending_payload ?? null,
      },
      svc,
    );
    if (!touch.ok) return { ok: false, error: touch.error };
    return { ok: true, contact_id: contactId, was_new_contact: false };
  }

  // No existing contact — pull user row for name + email + create.
  const { data: userRow } = await svc
    .from("users")
    .select("first_name, last_name, email, phone")
    .eq("id", user_id)
    .maybeSingle();
  const u = (userRow ?? null) as { first_name: string | null; last_name: string | null; email: string | null; phone: string | null } | null;

  const { data: created, error: insertErr } = await svc
    .from("contacts")
    .insert({
      tenant_id,
      user_id,
      first_name: u?.first_name ?? null,
      last_name: u?.last_name ?? null,
      email: u?.email ?? null,
      phone: u?.phone ?? null,
      source: "signup",
    })
    .select("id")
    .single();
  if (insertErr || !created) return { ok: false, error: `contact_create_failed:${insertErr?.message ?? "unknown"}` };

  const contactId = (created as { id: string }).id;
  // first-touch for new contact — agent_edit is not allowed here per
  // record-touch's invariant.
  const touch = await recordIdentificationTouch(
    {
      tenant_id,
      contact_id: contactId,
      is_new_contact: true,
      source_origin: source_origin === "agent_edit" ? "agent_set" : source_origin,
      payload: pending_payload ?? null,
    },
    svc,
  );
  if (!touch.ok) return { ok: false, error: touch.error };
  return { ok: true, contact_id: contactId, was_new_contact: true };
}
