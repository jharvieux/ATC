// §12.4 — Create a draft quote.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";

const QuoteCreateSchema = z.object({
  contact_id: z.string().uuid(),
  cruise_line: z.string().optional(),
  ship_name: z.string().optional(),
  sailing_date: z.string().optional(),
  duration_nights: z.number().int().positive().optional(),
  cabin_category: z.string().optional(),
  passenger_count: z.number().int().positive().optional(),
  commissionable_fare: z.number().positive().optional(),
  non_commissionable_total: z.number().min(0).optional(),
  total_amount: z.number().positive().optional(),
  valid_until: z.string().datetime().optional(),
  show_breakdown_to_customer: z.boolean().optional(),
  custom_notes: z.string().optional(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "quotes", action: "create" });
    const db = tenantClient(ctx);

    const body = await req.json();
    const parsed = QuoteCreateSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "Invalid body", details: parsed.error.issues }, { status: 400 });
    }

    const { data, error } = await db
      .from("quotes")
      .insert({ ...parsed.data, user_id: user.id, status: "draft" })
      .select()
      .single();

    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json(data, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}
