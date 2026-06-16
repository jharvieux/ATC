// §12.4 / §38 — Quote detail (container + representative option).
//
// GET /api/quotes/[id]
//
// Returns the quote container plus the option the quote should display as —
// the customer-selected option, else the lowest option_index (§38.4.3). The
// detail page reads trip + financial fields off `option`; all money is in
// cents. `option` is null for a container with no options yet (fresh draft);
// `option_count` lets the UI hint that more options exist behind the one shown.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { selectRepresentativeOption } from "@/lib/quotes/representative-option";
import { dbErrorResponse } from "@/lib/api/db-error-response";

interface DetailOption {
  option_index: number;
  customer_selected: boolean | null;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  cabin_category: string | null;
  passenger_count: number | null;
  commissionable_fare_cents: number | null;
  non_commissionable_total_cents: number | null;
  total_amount_cents: number | null;
  currency: string | null;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "quotes", action: "read" });
    const { id } = await params;
    const db = tenantClient(ctx);

    const { data: quote, error: quoteErr } = await db
      .from("quotes")
      .select("id, contact_id, status, custom_notes, show_breakdown_to_customer, created_at")
      .eq("id", id)
      .maybeSingle();
    if (quoteErr) return dbErrorResponse(quoteErr);
    if (!quote) return Response.json({ error: "not_found" }, { status: 404 });

    const { data: optionRows, error: optionsErr } = await db
      .from("quote_options")
      .select(
        "option_index, customer_selected, cruise_line, ship_name, sailing_date, duration_nights, cabin_category, passenger_count, commissionable_fare_cents, non_commissionable_total_cents, total_amount_cents, currency",
      )
      .eq("quote_id", id)
      .order("option_index", { ascending: true });
    if (optionsErr) return dbErrorResponse(optionsErr);

    const options = (optionRows ?? []) as DetailOption[];
    const option = selectRepresentativeOption(options);

    return Response.json({
      ...(quote as Record<string, unknown>),
      option,
      option_count: options.length,
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}
