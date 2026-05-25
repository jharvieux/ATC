// §12.4 — Create a draft quote.
// §35.6.1 — Quote creation copies the contact's most-recent attribution
// touch into conversion_touch_* columns.
// §38 — Quotes are now containers; per-option fields land in quote_options.
// During the deploy-1/deploy-2 window, this route writes a quote row +
// (when option-level fields are provided) a quote_options row at index 1.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { populateConversionTouch } from "@/lib/attribution/populate-conversion-touch";
import { respondToAuthError } from "@/lib/auth/respond";

const QuoteCreateSchema = z.object({
  contact_id: z.string().uuid(),
  // Container-level fields (§38.2.2):
  customer_facing_intro: z.string().optional(),
  show_recommendation: z.boolean().optional(),
  recommendation_rationale: z.string().optional(),
  valid_until: z.string().datetime().optional(),
  show_breakdown_to_customer: z.boolean().optional(),
  custom_notes: z.string().optional(),
  // Option-level fields (will be moved into a quote_options row at index 1
  // when present — supports the simple "single-option quote" callers).
  cruise_line: z.string().optional(),
  ship_name: z.string().optional(),
  sailing_date: z.string().optional(),
  duration_nights: z.number().int().positive().optional(),
  cabin_category: z.string().optional(),
  passenger_count: z.number().int().positive().optional(),
  commissionable_fare_cents: z.number().int().nonnegative().optional(),
  non_commissionable_total_cents: z.number().int().nonnegative().optional(),
  total_amount_cents: z.number().int().nonnegative().optional(),
  currency: z.string().optional(),
});

const OPTION_FIELDS = new Set([
  "cruise_line",
  "ship_name",
  "sailing_date",
  "duration_nights",
  "cabin_category",
  "passenger_count",
  "commissionable_fare_cents",
  "non_commissionable_total_cents",
  "total_amount_cents",
  "currency",
]);

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "quotes", action: "create" });
    const db = tenantClient(ctx);

    const body = await req.json();
    const parsed = QuoteCreateSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "Invalid body", details: parsed.error.issues }, { status: 400 });
    }

    // Split into container vs option fields.
    const containerFields: Record<string, unknown> = {};
    const optionFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      if (OPTION_FIELDS.has(k)) optionFields[k] = v;
      else containerFields[k] = v;
    }

    const { data: quote, error } = await db
      .from("quotes")
      .insert({ ...containerFields, user_id: user.id, status: "draft" })
      .select()
      .single();
    if (error) return Response.json({ error: error.message }, { status: 500 });

    const quoteId = (quote as { id: string }).id;

    // If caller provided option-level fields, materialize as the first
    // quote_options row. Multi-option callers post additional options to
    // /api/quotes/:id/options.
    if (Object.keys(optionFields).length > 0) {
      await db.from("quote_options").insert({
        tenant_id: ctx.tenant_id,
        quote_id: quoteId,
        option_index: 1,
        ...optionFields,
      });
    }

    // §35.6.1 — populate conversion_touch_* from the contact's most
    // recent attribution touch (or fallback to first_touch_*). Non-fatal:
    // failure here doesn't roll back the quote.
    await populateConversionTouch({
      tenant_id: ctx.tenant_id,
      contact_id: parsed.data.contact_id,
      target_table: "quotes",
      target_id: quoteId,
      svc: db,
    });

    return Response.json(quote, { status: 201 });
  } catch (err) {
    return respondToAuthError(err);
  }
}
