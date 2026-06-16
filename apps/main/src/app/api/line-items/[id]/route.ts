// BP40 §40 — Line-item PATCH/DELETE.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { computeExpectedCommissionCents, validateLineItem, type ItemType } from "@/lib/line-items/validate";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const PatchSchema = z.object({
  description: z.string().optional(),
  supplier_name: z.string().optional(),
  supplier_booking_ref: z.string().optional(),
  is_cruise_line_supplied: z.boolean().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  customer_cost_cents: z.number().int().nonnegative().optional(),
  supplier_net_cents: z.number().int().nonnegative().nullable().optional(),
  commissionable: z.boolean().optional(),
  commission_rate: z.number().min(0).max(1).nullable().optional(),
  received_commission_cents: z.number().int().nonnegative().optional(),
  currency: z.string().optional(),
  status: z.enum(["planned", "booked", "confirmed", "cancelled", "completed"]).optional(),
  cancellation_reason: z.string().nullable().optional(),
  item_details: z.record(z.unknown()).optional(),
  include_in_itinerary: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "bookings.line_items", action: "update" });
    const { id } = await params;
    const db = tenantClient(ctx);

    const body = await req.json();
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_body", details: parsed.error.issues }, { status: 400 });
    }

    // Load current row so we can re-validate + recompute commission.
    const { data: currentData } = await db
      .from("booking_line_items")
      .select("item_type, customer_cost_cents, commissionable, commission_rate, start_date, end_date, item_details")
      .eq("id", id)
      .maybeSingle();
    if (!currentData) return Response.json({ error: "not_found" }, { status: 404 });
    const current = currentData as {
      item_type: ItemType;
      customer_cost_cents: number;
      commissionable: boolean;
      commission_rate: number | null;
      start_date: string | null;
      end_date: string | null;
      item_details: Record<string, unknown> | null;
    };

    const merged = {
      item_type: current.item_type,
      start_date: parsed.data.start_date === undefined ? current.start_date : parsed.data.start_date,
      end_date: parsed.data.end_date === undefined ? current.end_date : parsed.data.end_date,
      item_details: parsed.data.item_details === undefined ? current.item_details : parsed.data.item_details,
    };

    const v = validateLineItem(merged);
    if (!v.ok) return Response.json({ error: "validation_failed", details: v.errors }, { status: 400 });

    const update: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };

    // Recompute expected commission if any commission-relevant field touched.
    const touchesCommission =
      parsed.data.commissionable !== undefined ||
      parsed.data.commission_rate !== undefined ||
      parsed.data.customer_cost_cents !== undefined;
    if (touchesCommission) {
      const nextCommissionable = parsed.data.commissionable ?? current.commissionable;
      const nextRate = parsed.data.commission_rate ?? current.commission_rate;
      const nextCost = parsed.data.customer_cost_cents ?? current.customer_cost_cents;
      update.expected_commission_cents = computeExpectedCommissionCents({
        commissionable: nextCommissionable,
        customer_cost_cents: nextCost,
        commission_rate: nextRate,
      });
    }

    const { data, error } = await db
      .from("booking_line_items")
      .update(update)
      .eq("id", id)
      .select()
      .single();
    if (error) return dbErrorResponse(error);
    return Response.json(data);
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "bookings.line_items", action: "delete" });
    const { id } = await params;
    const db = tenantClient(ctx);
    const { error } = await db.from("booking_line_items").delete().eq("id", id);
    if (error) return dbErrorResponse(error);
    return Response.json({ deleted: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}
