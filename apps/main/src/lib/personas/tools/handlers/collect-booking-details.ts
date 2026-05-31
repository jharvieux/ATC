// §9.6 — collect_booking_details handler.
//
// Creates a draft booking and pre-fills the lead passenger from
// data collected during the AI conversation. Returns a booking_url
// so the AI can hand the customer off to the on-page flow to confirm
// details and submit.
//
// NOT idempotent — two calls create two draft bookings. The AI should
// call this at most once per turn; the regen loop is harmless because
// the customer will only follow one booking_url.
//
// quote_id is accepted (per the tool schema) but not stored — the
// bookings table has no quote_id column yet (TODO(prompt-13) in tools.ts).

import { z } from "zod";
import type { ToolDispatchContext, ToolResult } from "../dispatch";
import { safeAwait } from "@/lib/db/safe-mutation";

const DOB_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const InputSchema = z.object({
  // quote_id is optional here — the column doesn't exist in bookings yet
  // (TODO(prompt-13) in tools.ts). Required in the LLM tool schema so the AI
  // always sends it, but we don't store it until the column lands.
  quote_id: z.string().min(1).optional(),
  primary_guest: z.object({
    first_name: z.string().min(1),
    last_name: z.string().min(1),
    date_of_birth: z.string().regex(DOB_REGEX, "Must be YYYY-MM-DD").optional(),
    // email + phone not stored (no booking/passenger column yet); omitted from
  // schema so Zod strips them rather than accepting and silently discarding.
  }),
  special_requests: z.string().optional(),
});

export async function collectBookingDetails(
  rawInput: Record<string, unknown>,
  dispatchCtx: ToolDispatchContext,
): Promise<ToolResult> {
  const parsed = InputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      content: JSON.stringify({ error: "invalid_input", detail: parsed.error.message }),
      was_mutating: false,
    };
  }
  const { primary_guest, special_requests } = parsed.data;

  const { data: booking, error: bErr } = await dispatchCtx.db
    .from("bookings")
    .insert({
      tenant_id: dispatchCtx.ctx.tenant_id,
      primary_contact_id: dispatchCtx.contact_id ?? null,
      status: "draft",
      notes: special_requests ?? null,
    })
    .select("id")
    .single();

  if (bErr || !booking) {
    throw new Error(`bookings.insert failed: ${bErr?.message ?? "no row returned"}`);
  }

  const bookingId = booking.id as string;

  const canPreFill = !!primary_guest.date_of_birth;

  if (canPreFill) {
    await safeAwait(
      dispatchCtx.db.from("booking_passengers").insert({
        booking_id: bookingId,
        tenant_id: dispatchCtx.ctx.tenant_id,
        contact_id: dispatchCtx.contact_id ?? null,
        legal_first_name: primary_guest.first_name,
        legal_last_name: primary_guest.last_name,
        date_of_birth: primary_guest.date_of_birth!,
        date_of_birth_is_estimated: false,
        is_lead_passenger: true,
      }),
      "booking_passengers.insert",
    );
  }

  const stage = canPreFill ? 2 : 1;
  const bookingUrl = `/booking/flow/${bookingId}/${stage}`;

  const message = canPreFill
    ? `I've started a booking and pre-filled ${primary_guest.first_name}'s details. Follow the link to confirm your passenger information and complete the booking.`
    : "I've started a booking for you. Follow the link to fill in your passenger details and complete the booking.";

  return {
    content: JSON.stringify({ ok: true, booking_id: bookingId, booking_url: bookingUrl, message }),
    was_mutating: true,
  };
}
