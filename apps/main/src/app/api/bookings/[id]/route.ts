// §7.6 — Booking (get + patch).
//
// GET returns the booking row + the primary contact (name + email) so
// the detail page can render a header without a second round-trip.
// Tenant-scoped via tenantClient.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { safeAwait } from "@/lib/db/safe-mutation";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { fromCents } from "@/lib/money";
import { isStatusPatchable, isFieldPatchable } from "@/lib/bookings/patchable-fields";
import { resolveCanonical } from "@/lib/canonical/resolve-canonical";

interface BookingRow {
  id: string;
  tenant_id: string;
  status: string;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  cabin_category: string | null;
  departure_port: string | null;
  total_amount_cents: number | bigint | null;
  commissionable_fare_cents: number | bigint | null;
  currency: string | null;
  primary_contact_id: string | null;
  host_adapter: string | null;
  provider_booking_ref: string | null;
  is_sandbox: boolean | null;
  created_at: string;
  updated_at: string;
}

interface ContactRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let auth;
  try {
    auth = await assertPermission(req, { resource: "bookings", action: "read" });
  } catch (err) {
    return respondToAuthError(err);
  }
  const { id } = await params;
  const db = tenantClient(auth.ctx);

  const { data: bookingData, error: bookingErr } = await db
    .from("bookings")
    .select(
      // #1190: the columns are provider_booking_ref and is_sandbox (the response
      // exposes them as host_booking_reference / is_test — see serializeBooking).
      // ai_paused_by_platform is a tenants column, never consumed here — dropped.
      "id, tenant_id, status, cruise_line, ship_name, sailing_date, duration_nights, cabin_category, departure_port, total_amount_cents, commissionable_fare_cents, currency, primary_contact_id, host_adapter, provider_booking_ref, is_sandbox, created_at, updated_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (bookingErr) return dbErrorResponse(bookingErr);
  if (!bookingData) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const booking = bookingData as BookingRow;

  let primary_contact: ContactRow | null = null;
  if (booking.primary_contact_id) {
    const { data: contactData, error: contactErr } = await db
      .from("contacts")
      .select("id, first_name, last_name, email")
      .eq("id", booking.primary_contact_id)
      .maybeSingle();
    if (contactErr) {
      console.warn(`[bookings.get] contact lookup failed: ${contactErr.message}`);
    } else if (contactData) {
      primary_contact = contactData as ContactRow;
    }
  }

  return Response.json({
    booking: serializeBooking(booking),
    primary_contact,
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let auth;
  try {
    auth = await assertPermission(req, { resource: "bookings", action: "update" });
  } catch (err) {
    return respondToAuthError(err);
  }
  const { id } = await params;
  const db = tenantClient(auth.ctx);

  let body: Partial<BookingRow>;
  try {
    body = (await req.json()) as Partial<BookingRow>;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  // Load current status to gate the patch.
  const { data: currentData, error: currentErr } = await db
    .from("bookings")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  if (currentErr) return dbErrorResponse(currentErr);
  if (!currentData) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  const currentStatus = (currentData as { status: string }).status;

  if (!isStatusPatchable(currentStatus)) {
    return Response.json(
      {
        error: "status_locks_edits",
        current_status: currentStatus,
        message:
          currentStatus === "submitting"
            ? "Booking submission is in flight. Wait for it to finish before editing."
            : currentStatus === "submitted" || currentStatus === "confirmed"
              ? "Submitted bookings must be changed via the modify flow, not direct edit."
              : `Edits not allowed in '${currentStatus}' state.`,
      },
      { status: 409 },
    );
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const rejected: string[] = [];
  for (const key of Object.keys(body) as Array<keyof BookingRow>) {
    if (key === "id" || key === "tenant_id" || key === "status" || key === "created_at" || key === "updated_at") {
      // Silently ignore — these are platform-managed.
      continue;
    }
    if (isFieldPatchable(currentStatus, key)) {
      patch[key as string] = body[key];
    } else if (body[key] !== undefined) {
      rejected.push(String(key));
    }
  }
  if (rejected.length > 0) {
    return Response.json(
      {
        error: "field_not_editable_in_status",
        current_status: currentStatus,
        rejected_fields: rejected,
      },
      { status: 400 },
    );
  }
  if (Object.keys(patch).length === 1) {
    return Response.json({ error: "no_updatable_fields" }, { status: 400 });
  }

  if ("cruise_line" in patch) {
    const r = await resolveCanonical(patch.cruise_line as string | undefined, "line", db);
    patch.cruise_line_id = r.matched ? r.id : null;
  }
  if ("ship_name" in patch) {
    const r = await resolveCanonical(patch.ship_name as string | undefined, "ship", db);
    patch.cruise_ship_id = r.matched ? r.id : null;
  }

  await safeAwait(
    db.from("bookings").update(patch).eq("id", id),
    "bookings.update",
  );

  return Response.json({ ok: true, status: currentStatus });
}

// bigint isn't JSON-serializable; format via fromCents to a decimal string
// the client renders directly (no client-side _cents arithmetic).
function serializeBooking(b: BookingRow) {
  const {
    total_amount_cents,
    commissionable_fare_cents,
    provider_booking_ref,
    is_sandbox,
    ...rest
  } = b;
  return {
    ...rest,
    // #1190: expose the real columns under the names the detail UI consumes.
    host_booking_reference: provider_booking_ref,
    is_test: is_sandbox,
    total_amount: total_amount_cents === null ? null : fromCents(BigInt(total_amount_cents)),
    commissionable_fare:
      commissionable_fare_cents === null ? null : fromCents(BigInt(commissionable_fare_cents)),
  };
}
