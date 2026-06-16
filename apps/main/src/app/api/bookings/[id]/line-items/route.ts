// BP40 §40.5 — Per-booking line items: list + create.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertLineItemsAvailable } from "@/lib/line-items/tier-gate";
import { computeExpectedCommissionCents, validateLineItem, type ItemType } from "@/lib/line-items/validate";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const LineItemCreateSchema = z.object({
  item_type: z.enum(["flight", "hotel", "transfer", "excursion", "insurance", "other"]),
  description: z.string().min(1),
  supplier_name: z.string().optional(),
  supplier_booking_ref: z.string().optional(),
  is_cruise_line_supplied: z.boolean().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  customer_cost_cents: z.number().int().nonnegative(),
  supplier_net_cents: z.number().int().nonnegative().optional(),
  commissionable: z.boolean().optional(),
  commission_rate: z.number().min(0).max(1).optional(),
  currency: z.string().optional(),
  status: z.enum(["planned", "booked", "confirmed", "cancelled", "completed"]).optional(),
  item_details: z.record(z.unknown()).optional(),
  include_in_itinerary: z.boolean().optional(),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "bookings.line_items", action: "list" });
    const { id: bookingId } = await params;
    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("booking_line_items")
      .select("*")
      .eq("booking_id", bookingId)
      .order("start_date", { ascending: true, nullsFirst: false });
    if (error) return dbErrorResponse(error);
    return Response.json({ items: data ?? [] });
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "bookings.line_items", action: "create" });
    const { id: bookingId } = await params;
    const db = tenantClient(ctx);
    const svc = createServiceRoleClient();

    const gate = await assertLineItemsAvailable(ctx.tenant_id, svc);
    if (!gate.ok) return Response.json({ error: gate.reason }, { status: 403 });

    const body = await req.json();
    const parsed = LineItemCreateSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_body", details: parsed.error.issues }, { status: 400 });
    }

    const v = validateLineItem({
      item_type: parsed.data.item_type as ItemType,
      start_date: parsed.data.start_date ?? null,
      end_date: parsed.data.end_date ?? null,
      item_details: parsed.data.item_details ?? null,
    });
    if (!v.ok) {
      return Response.json({ error: "validation_failed", details: v.errors }, { status: 400 });
    }

    const expected_commission_cents = computeExpectedCommissionCents({
      commissionable: parsed.data.commissionable ?? false,
      customer_cost_cents: parsed.data.customer_cost_cents,
      commission_rate: parsed.data.commission_rate ?? null,
    });

    const { data, error } = await db
      .from("booking_line_items")
      .insert({
        ...parsed.data,
        tenant_id: ctx.tenant_id,
        booking_id: bookingId,
        created_by_user_id: user.id,
        expected_commission_cents,
        // §40.6 — 'other' defaults to NOT shown on itinerary unless caller overrides.
        include_in_itinerary:
          parsed.data.include_in_itinerary ?? (parsed.data.item_type !== "other"),
      })
      .select()
      .single();
    if (error) return dbErrorResponse(error);
    return Response.json(data, { status: 201 });
  } catch (err) {
    return respondToAuthError(err);
  }
}
