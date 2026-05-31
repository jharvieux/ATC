// §20.2 — Booking options (add-ons / insurance).
//
// GET /api/bookings/[id]/options — list selected add-ons.
// PUT /api/bookings/[id]/options — replace selected add-ons.
//     Body: { options: OptionInput[] }
//
// PUT replaces the whole set so the Stage 3 UI sends a single payload on
// advance. An empty array clears all options (customer selected none).
//
// RLS on booking_options grants SELECT/INSERT/UPDATE/DELETE to authenticated
// users scoped by tenant_id — tenantClient is sufficient.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";
import { tenantClient } from "@/lib/db/tenant-client";
import { safeAwait } from "@/lib/db/safe-mutation";

const OptionSchema = z.object({
  option_kind: z.string().min(1),
  option_value: z.record(z.unknown()),
  price_cents: z.number().int().nonnegative().default(0),
});

const PutBodySchema = z.object({
  options: z.array(OptionSchema),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let auth;
  try {
    auth = await assertPermission(req, { resource: "bookings.options", action: "read" });
  } catch (err) {
    return respondToAuthError(err);
  }
  const { id } = await params;
  const db = tenantClient(auth.ctx);

  // Verify booking exists in this tenant.
  const { data: booking, error: bErr } = await db
    .from("bookings")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (bErr) return Response.json({ error: "booking_lookup_failed" }, { status: 500 });
  if (!booking) return Response.json({ error: "not_found" }, { status: 404 });

  const { data: options, error: oErr } = await db
    .from("booking_options")
    .select("id, option_kind, option_value, price_cents, created_at")
    .eq("booking_id", id)
    .order("created_at", { ascending: true });

  if (oErr) return Response.json({ error: "options_lookup_failed" }, { status: 500 });

  return Response.json({ options: options ?? [] });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let auth;
  try {
    auth = await assertPermission(req, { resource: "bookings.options", action: "write" });
  } catch (err) {
    return respondToAuthError(err);
  }
  const { id } = await params;

  const body: unknown = await req.json().catch(() => null);
  const parsed = PutBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body", details: parsed.error.flatten() }, { status: 400 });
  }
  const { options } = parsed.data;

  const db = tenantClient(auth.ctx);

  // Verify booking belongs to this tenant.
  const { data: booking, error: bErr } = await db
    .from("bookings")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (bErr) return Response.json({ error: "booking_lookup_failed" }, { status: 500 });
  if (!booking) return Response.json({ error: "not_found" }, { status: 404 });

  // Replace all options: delete existing, then insert new set.
  await safeAwait(
    db.from("booking_options").delete().eq("booking_id", id),
    "booking_options.delete",
  );

  if (options.length > 0) {
    const rows = options.map((o) => ({
      booking_id: id,
      tenant_id: auth.ctx.tenant_id,
      option_kind: o.option_kind,
      option_value: o.option_value,
      price_cents: o.price_cents,
    }));
    await safeAwait(db.from("booking_options").insert(rows), "booking_options.insert");
  }

  return Response.json({ ok: true, count: options.length });
}
