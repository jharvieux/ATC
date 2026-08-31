// §23.4 — Staff-triggered pre-cruise email dispatch.
//
// Manual sends and schedules emit the same event as the automatic cadence, so
// rendering, suppression, idempotency, retries, and email logging stay in one
// production path. Scheduled events use Inngest's durable future timestamp.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { tenantClient } from "@/lib/db/tenant-client";
import { inngest } from "@/inngest/client";
import { validateInngestEvent } from "@/lib/inngest/event-registry";

const ActionSchema = z.enum(["send_now", "schedule"]);
const PhaseSchema = z.enum(["t_90", "t_30", "t_7", "t_1"]);
const DispatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("send_now"),
    booking_id: z.string().uuid(),
    phase: PhaseSchema,
  }),
  z.object({
    action: z.literal("schedule"),
    booking_id: z.string().uuid(),
    phase: PhaseSchema,
    scheduled_for: z.string().datetime({ offset: true }),
  }),
]);

const MIN_SCHEDULE_LEAD_MS = 60_000;
const MAX_SCHEDULE_LEAD_MS = 365 * 24 * 60 * 60 * 1000;

interface BookingRow {
  id: string;
  status: string;
  primary_contact_id: string | null;
  sailing_date: string | null;
  groups: Array<{ sailing_date: string | null }> | { sailing_date: string | null } | null;
}

export async function POST(req: Request): Promise<Response> {
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const actionResult = ActionSchema.safeParse(
    rawBody && typeof rawBody === "object" ? (rawBody as { action?: unknown }).action : undefined,
  );
  if (!actionResult.success) {
    return Response.json({ error: "invalid_action" }, { status: 400 });
  }

  let auth;
  try {
    auth = await assertPermission(req, {
      resource: "precruise_emails",
      action: actionResult.data === "send_now" ? "send" : "schedule",
    });
  } catch (err) {
    return respondToAuthError(err);
  }

  const parsed = DispatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  let scheduledMs: number | null = null;
  if (parsed.data.action === "schedule") {
    scheduledMs = Date.parse(parsed.data.scheduled_for);
    const leadMs = scheduledMs - Date.now();
    if (leadMs < MIN_SCHEDULE_LEAD_MS || leadMs > MAX_SCHEDULE_LEAD_MS) {
      return Response.json({ error: "invalid_schedule_time" }, { status: 400 });
    }
  }

  const db = tenantClient(auth.ctx);
  const { data: bookingData, error: bookingError } = await db
    .from("bookings")
    .select("id, status, primary_contact_id, sailing_date, groups(sailing_date)")
    .eq("id", parsed.data.booking_id)
    .maybeSingle();
  if (bookingError) return dbErrorResponse(bookingError);
  if (!bookingData) {
    return Response.json({ error: "booking_not_found" }, { status: 404 });
  }

  const booking = bookingData as BookingRow;
  if (booking.status !== "confirmed") {
    return Response.json({ error: "booking_not_confirmed" }, { status: 409 });
  }
  const groups = Array.isArray(booking.groups) ? booking.groups[0] : booking.groups;
  if (!booking.sailing_date && !groups?.sailing_date) {
    return Response.json({ error: "sailing_date_missing" }, { status: 422 });
  }
  if (!booking.primary_contact_id) {
    return Response.json({ error: "recipient_missing" }, { status: 422 });
  }

  const { data: contactData, error: contactError } = await db
    .from("contacts")
    .select("email")
    .eq("id", booking.primary_contact_id)
    .maybeSingle();
  if (contactError) return dbErrorResponse(contactError);
  const email = (contactData as { email: string | null } | null)?.email?.trim();
  if (!email) {
    return Response.json({ error: "recipient_missing" }, { status: 422 });
  }

  const { data: existingData, error: existingError } = await db
    .from("pre_cruise_email_content")
    .select("sent_at")
    .eq("booking_id", booking.id)
    .eq("email_phase", parsed.data.phase)
    .maybeSingle();
  if (existingError) return dbErrorResponse(existingError);
  if ((existingData as { sent_at?: string | null } | null)?.sent_at) {
    return Response.json({ error: "phase_already_sent" }, { status: 409 });
  }

  const eventData = {
    booking_id: booking.id,
    tenant_id: auth.ctx.tenant_id,
    phase: parsed.data.phase,
    via: "direct" as const,
  };
  validateInngestEvent("precruise/email.due", eventData);

  const dispatchKey = scheduledMs ?? Math.floor(Date.now() / MIN_SCHEDULE_LEAD_MS);
  try {
    await inngest.send({
      id: `manual-precruise:${booking.id}:${parsed.data.phase}:${dispatchKey}`,
      name: "precruise/email.due",
      data: eventData,
      ...(scheduledMs === null ? {} : { ts: scheduledMs }),
    });
  } catch (err) {
    console.error("[precruise-dispatch] failed to enqueue", err);
    return Response.json({ error: "dispatch_unavailable" }, { status: 502 });
  }

  return Response.json(
    {
      ok: true,
      action: parsed.data.action,
      phase: parsed.data.phase,
      scheduled_for: parsed.data.action === "schedule" ? parsed.data.scheduled_for : null,
    },
    { status: 202 },
  );
}
