// BP38 §38 — Single-option PATCH/DELETE.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { validateLineItems, type LineItem } from "@/lib/quotes/line-items";
import { respondToAuthError } from "@/lib/auth/respond";
import { resolveCanonical } from "@/lib/canonical/resolve-canonical";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const OptionPatchSchema = z.object({
  label: z.string().optional(),
  cruise_line: z.string().optional(),
  ship_name: z.string().optional(),
  sailing_date: z.string().optional(),
  duration_nights: z.number().int().positive().optional(),
  departure_port: z.string().optional(),
  cabin_category: z.string().optional(),
  passenger_count: z.number().int().positive().optional(),
  commissionable_fare_cents: z.number().int().nonnegative().optional(),
  non_commissionable_total_cents: z.number().int().nonnegative().optional(),
  total_amount_cents: z.number().int().nonnegative().optional(),
  currency: z.string().optional(),
  line_items: z.array(z.unknown()).optional(),
  is_recommended: z.boolean().optional(),
  option_notes: z.string().optional(),
  pros: z.array(z.string()).optional(),
  cons: z.array(z.string()).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "quotes.options", action: "update" });
    const { id } = await params;
    const db = tenantClient(ctx);

    const body = await req.json();
    const parsed = OptionPatchSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_body", details: parsed.error.issues }, { status: 400 });
    }

    // Line-item validation if a PATCH touches both line_items + financials.
    if (
      parsed.data.line_items &&
      typeof parsed.data.total_amount_cents === "number" &&
      typeof parsed.data.commissionable_fare_cents === "number"
    ) {
      const v = validateLineItems(parsed.data.line_items as LineItem[], {
        total_amount_cents: parsed.data.total_amount_cents,
        commissionable_fare_cents: parsed.data.commissionable_fare_cents,
      });
      if (!v.ok) {
        return Response.json({ error: "line_item_validation_failed", details: v.errors }, { status: 400 });
      }
    }

    const extraFks: Record<string, string | null> = {};
    if (parsed.data.cruise_line !== undefined) {
      const r = await resolveCanonical(parsed.data.cruise_line, "line", db);
      extraFks.cruise_line_id = r.matched ? r.id : null;
    }
    if (parsed.data.ship_name !== undefined) {
      const r = await resolveCanonical(parsed.data.ship_name, "ship", db);
      extraFks.cruise_ship_id = r.matched ? r.id : null;
    }

    const { data, error } = await db
      .from("quote_options")
      .update({ ...parsed.data, ...extraFks, updated_at: new Date().toISOString() })
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
    const { ctx } = await assertPermission(req, { resource: "quotes.options", action: "delete" });
    const { id } = await params;
    const db = tenantClient(ctx);
    const { error } = await db.from("quote_options").delete().eq("id", id);
    if (error) return dbErrorResponse(error);
    return Response.json({ deleted: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}
