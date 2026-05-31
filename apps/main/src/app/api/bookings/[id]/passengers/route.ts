// §20.2 / §20.5 — Booking passenger CRUD.
//
// GET  /api/bookings/[id]/passengers — list passengers on the booking.
// POST /api/bookings/[id]/passengers — replace all passengers (full upsert).
//      Body: { passengers: PassengerInput[] }
//
// POST replaces the whole set (delete existing rows, insert new ones) so the
// UI can send a single payload on Stage 2 advance without managing individual
// create/update/delete calls. Idempotent: re-submitting the same passenger
// list is safe.
//
// RLS on booking_passengers grants SELECT/INSERT/UPDATE/DELETE to authenticated
// users scoped by tenant_id — tenantClient is sufficient; no service-role needed.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";
import { tenantClient } from "@/lib/db/tenant-client";
import { safeAwait } from "@/lib/db/safe-mutation";

const PassengerSchema = z.object({
  legal_first_name: z.string().min(1),
  legal_last_name: z.string().min(1),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
  date_of_birth_is_estimated: z.boolean().optional().default(false),
  passport_number: z.string().optional().nullable(),
  passport_expiry: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional()
    .nullable(),
  passport_country: z.string().optional().nullable(),
  is_lead_passenger: z.boolean().optional().default(false),
});

const PostBodySchema = z.object({
  passengers: z.array(PassengerSchema).min(1, "At least one passenger required"),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let auth;
  try {
    auth = await assertPermission(req, { resource: "bookings.passengers", action: "read" });
  } catch (err) {
    return respondToAuthError(err);
  }
  const { id } = await params;
  const db = tenantClient(auth.ctx);

  const { data: booking, error: bErr } = await db
    .from("bookings")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (bErr) return Response.json({ error: "booking_lookup_failed" }, { status: 500 });
  if (!booking) return Response.json({ error: "not_found" }, { status: 404 });

  const { data: passengers, error: pErr } = await db
    .from("booking_passengers")
    .select(
      "id, legal_first_name, legal_last_name, date_of_birth, date_of_birth_is_estimated, passport_expiry, passport_country, is_lead_passenger, created_at",
    )
    .eq("booking_id", id)
    .order("is_lead_passenger", { ascending: false })
    .order("created_at", { ascending: true });

  if (pErr) return Response.json({ error: "passengers_lookup_failed" }, { status: 500 });

  return Response.json({ passengers: passengers ?? [] });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const auth = await assertPermission(req, { resource: "bookings.passengers", action: "write" });
    const { id } = await params;

    const body: unknown = await req.json().catch(() => null);
    const parsed = PostBodySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_body", details: parsed.error.flatten() }, { status: 400 });
    }
    const { passengers } = parsed.data;

    const leadCount = passengers.filter((p) => p.is_lead_passenger).length;
    if (leadCount === 0) passengers[0]!.is_lead_passenger = true;
    if (leadCount > 1) {
      return Response.json({ error: "multiple_lead_passengers" }, { status: 400 });
    }

    const db = tenantClient(auth.ctx);

    // RLS enforces this; explicit check gives callers a clear 404.
    const { data: booking, error: bErr } = await db
      .from("bookings")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (bErr) return Response.json({ error: "booking_lookup_failed" }, { status: 500 });
    if (!booking) return Response.json({ error: "not_found" }, { status: 404 });

    // Non-atomic: if insert fails after delete, booking_passengers is empty until
    // the caller retries Stage 2. Acceptable for draft bookings — the form
    // re-loads empty and the user re-submits.
    await safeAwait(
      db.from("booking_passengers").delete().eq("booking_id", id),
      "booking_passengers.delete",
    );

    const rows = passengers.map((p) => ({
      booking_id: id,
      tenant_id: auth.ctx.tenant_id,
      legal_first_name: p.legal_first_name,
      legal_last_name: p.legal_last_name,
      date_of_birth: p.date_of_birth,
      date_of_birth_is_estimated: p.date_of_birth_is_estimated ?? false,
      passport_number_encrypted: p.passport_number || null,
      passport_expiry: p.passport_expiry ?? null,
      passport_country: p.passport_country ?? null,
      is_lead_passenger: p.is_lead_passenger ?? false,
    }));

    await safeAwait(db.from("booking_passengers").insert(rows), "booking_passengers.insert");

    return Response.json({ ok: true, count: rows.length });
  } catch (err) {
    return respondToAuthError(err);
  }
}
