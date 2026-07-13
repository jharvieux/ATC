// BP38 §38.3 — Quote-options CRUD.
//
// GET — list options for the quote (ordered by option_index)
// POST — add a new option (enforces tier max + auto-assigns next index)

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { getMaxOptionsForTenant } from "@/lib/quotes/tier-gate";
import { validateLineItems, type LineItem } from "@/lib/quotes/line-items";
import { respondToAuthError } from "@/lib/auth/respond";
import { resolveCanonical } from "@/lib/canonical/resolve-canonical";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { safeAwait } from "@/lib/db/safe-mutation";
import { resolveQuoteKind, NO_HOST_INTEGRATION_ADAPTER } from "@/lib/quotes/kind-resolver";

const OptionCreateSchema = z.object({
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

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "quotes.options", action: "list" });
    const { id: quoteId } = await params;
    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("quote_options")
      .select("*")
      .eq("quote_id", quoteId)
      .order("option_index", { ascending: true });
    if (error) return dbErrorResponse(error);
    return Response.json({ options: data ?? [] });
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "quotes.options", action: "create" });
    const { id: quoteId } = await params;
    const db = tenantClient(ctx);
    const svc = createServiceRoleClient();

    // Tier-cap on options per quote.
    const maxOptions = await getMaxOptionsForTenant(ctx.tenant_id, svc);
    const { data: existing } = await db
      .from("quote_options")
      .select("id, option_index")
      .eq("quote_id", quoteId);
    const existingRows = (existing ?? []) as Array<{ id: string; option_index: number }>;
    if (existingRows.length >= maxOptions) {
      return Response.json(
        { error: "max_options_reached", max: maxOptions, current: existingRows.length },
        { status: 409 },
      );
    }

    const body = await req.json();
    const parsed = OptionCreateSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_body", details: parsed.error.issues }, { status: 400 });
    }

    // §38.5 line-item validation (only when all three financials provided).
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

    // Next option_index = max(existing) + 1.
    const nextIndex = existingRows.length > 0
      ? Math.max(...existingRows.map((r) => r.option_index)) + 1
      : 1;

    const [lineRes, shipRes] = await Promise.all([
      resolveCanonical(parsed.data.cruise_line, "line", db),
      resolveCanonical(parsed.data.ship_name, "ship", db),
    ]);

    const { data, error } = await db
      .from("quote_options")
      .insert({
        ...parsed.data,
        tenant_id: ctx.tenant_id,
        quote_id: quoteId,
        option_index: nextIndex,
        ...(lineRes.matched && { cruise_line_id: lineRes.id }),
        ...(shipRes.matched && { cruise_ship_id: shipRes.id }),
      })
      .select()
      .single();
    if (error) return dbErrorResponse(error);

    // #1804 — the #1742 price_kind/priced_at wiring only covered POST
    // /api/quotes' single-option creation path. Quotes built through this
    // multi-option endpoint (the primary §38 flow) never got their parent
    // priced_at/price_kind stamped, so quote-estimate-expiry-sweep's
    // `.lt("priced_at", cutoff)` filter silently matched zero of them
    // (NULL < x is never true). Only stamp on FIRST pricing — a quote
    // already priced by an earlier option keeps its existing priced_at
    // freshness window; re-pricing an existing option goes through the
    // PATCH route below instead.
    if (typeof parsed.data.total_amount_cents === "number") {
      const { data: quoteRow, error: quoteReadErr } = await db
        .from("quotes")
        .select("priced_at")
        .eq("id", quoteId)
        .single();
      if (quoteReadErr) return dbErrorResponse(quoteReadErr);
      if ((quoteRow as { priced_at: string | null }).priced_at == null) {
        const pricedAt = new Date().toISOString();
        await safeAwait(
          db.from("quotes").update({
            priced_at: pricedAt,
            price_kind: resolveQuoteKind(
              { priced_at: pricedAt, price_lock_token: null, price_lock_expires_at: null },
              NO_HOST_INTEGRATION_ADAPTER,
            ),
          }).eq("id", quoteId),
          "quotes.update.price_kind_from_option_create",
        );
      }
    }

    return Response.json(data, { status: 201 });
  } catch (err) {
    return respondToAuthError(err);
  }
}
