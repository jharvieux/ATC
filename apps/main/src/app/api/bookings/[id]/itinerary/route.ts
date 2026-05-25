// BP39 §39.2 — Generate (or fetch) the booking's itinerary draft.
//
// POST creates a draft if one doesn't exist (idempotent: returns the
// existing draft if booking already has one).
// GET fetches the current itinerary (any status) for the agent.

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertDeliverablesAvailable } from "@/lib/deliverables/tier-gate";
import { newAccessToken } from "@/lib/deliverables/token";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { ctx } = await assertPermission(req, { resource: "bookings.itinerary", action: "read" });
  const { id: bookingId } = await params;
  const svc = createServiceRoleClient();
  const { data, error } = await svc
    .from("trip_itineraries")
    .select("*")
    .eq("tenant_id", ctx.tenant_id)
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ itinerary: null });
  return Response.json({ itinerary: data });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { ctx } = await assertPermission(req, { resource: "bookings.itinerary", action: "create" });
  const { id: bookingId } = await params;
  const svc = createServiceRoleClient();

  const gate = await assertDeliverablesAvailable(ctx.tenant_id, svc);
  if (!gate.ok) return Response.json({ error: gate.reason }, { status: 403 });

  // Tenant-scope check on the booking.
  const { data: booking } = await svc
    .from("bookings")
    .select("id, tenant_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking || (booking as { tenant_id: string }).tenant_id !== ctx.tenant_id) {
    return Response.json({ error: "booking_not_found" }, { status: 404 });
  }

  // Idempotent.
  const { data: existing } = await svc
    .from("trip_itineraries")
    .select("*")
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (existing) return Response.json({ itinerary: existing, created: false });

  const { data: created, error } = await svc
    .from("trip_itineraries")
    .insert({
      tenant_id: ctx.tenant_id,
      booking_id: bookingId,
      access_token: newAccessToken(),
      status: "draft",
    })
    .select()
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ itinerary: created, created: true }, { status: 201 });
}
