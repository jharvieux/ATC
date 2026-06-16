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
import { safeAwait } from "@/lib/db/safe-mutation";
import { selectRepresentativeOption } from "@/lib/quotes/representative-option";
import { resolveCanonical } from "@/lib/canonical/resolve-canonical";
import { dbErrorResponse } from "@/lib/api/db-error-response";

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

// §12.4 / §38 — Quote list. Each row carries its representative option's trip
// summary (customer-selected option, else lowest option_index per §38.4.3).
// quotes is a container now (trip + total moved to quote_options), so this is
// two reads — the container list, then the options for those quotes grouped
// in-process — rather than an N+1 per row.
interface QuoteListOption {
  quote_id: string;
  option_index: number;
  customer_selected: boolean | null;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  total_amount_cents: number | null;
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "quotes", action: "read" });
    const db = tenantClient(ctx);

    const { data: quoteRows, error: quotesErr } = await db
      .from("quotes")
      .select("id, status, created_at")
      .order("created_at", { ascending: false });
    if (quotesErr) return dbErrorResponse(quotesErr);

    const quotes = (quoteRows ?? []) as Array<{ id: string; status: string; created_at: string }>;
    if (quotes.length === 0) return Response.json({ quotes: [] });

    const { data: optionRows, error: optionsErr } = await db
      .from("quote_options")
      .select(
        "quote_id, option_index, customer_selected, cruise_line, ship_name, sailing_date, total_amount_cents, cruise_line_id, cruise_lines(display_name)",
      )
      .in("quote_id", quotes.map((q) => q.id))
      .order("option_index", { ascending: true });
    if (optionsErr) return dbErrorResponse(optionsErr);

    const byQuote = new Map<string, QuoteListOption[]>();
    for (const row of (optionRows ?? []) as QuoteListOption[]) {
      const existing = byQuote.get(row.quote_id);
      if (existing) existing.push(row);
      else byQuote.set(row.quote_id, [row]);
    }

    const items = quotes.map((q) => {
      const option = selectRepresentativeOption(byQuote.get(q.id) ?? []);
      return {
        id: q.id,
        status: q.status,
        created_at: q.created_at,
        cruise_line: option?.cruise_line ?? null,
        ship_name: option?.ship_name ?? null,
        sailing_date: option?.sailing_date ?? null,
        total_amount_cents: option?.total_amount_cents ?? null,
      };
    });

    return Response.json({ quotes: items });
  } catch (err) {
    return respondToAuthError(err);
  }
}

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
    if (error) return dbErrorResponse(error);

    const quoteId = (quote as { id: string }).id;

    // If caller provided option-level fields, materialize as the first
    // quote_options row. Multi-option callers post additional options to
    // /api/quotes/:id/options.
    if (Object.keys(optionFields).length > 0) {
      const [lineRes, shipRes] = await Promise.all([
        resolveCanonical(optionFields.cruise_line as string | undefined, "line", db),
        resolveCanonical(optionFields.ship_name as string | undefined, "ship", db),
      ]);
      await safeAwait(db.from("quote_options").insert({
        tenant_id: ctx.tenant_id,
        quote_id: quoteId,
        option_index: 1,
        ...optionFields,
        ...(lineRes.matched && { cruise_line_id: lineRes.id }),
        ...(shipRes.matched && { cruise_ship_id: shipRes.id }),
      }), "quote_options.insert");
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
