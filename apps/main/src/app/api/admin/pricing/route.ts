// EPIC #1336 Phase 3 — platform-admin subscription pricing API.
//
// GET  returns the current pricing picture: per-tier base prices
//      (tier_definitions), the Stripe Price-ID map, and the agency seat ladder.
// PUT  applies one edit, discriminated by `kind`:
//        { kind: "stripe_price", tenant_type, tier, billing_period, line_item, amount_cents }
//          → creates a new Stripe Price, repoints the product default, updates
//            stripe_price_map (+ tier_definitions for base line items).
//        { kind: "seat_ladder", bands: [...] }
//          → DB-only replacement of the graduated seat ladder (no Stripe).
//
// Auth: assertPlatformAdminArea(req, "pricing") — superadmin + finance.
// Every call is wrapped in withPlatformAdminAudit, so each edit writes one
// audit_log row capturing operator + reason.
//
// Cache note: lib/pricing/pricing-table.ts and lib/stripe/price-ids.ts hold
// 60s in-process caches per serverless instance. There is no cross-instance
// hard-invalidate, so an edit propagates to all readers within ≤60s (TTL). This
// is acceptable for prices, which change rarely.

import Stripe from "stripe";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { safeAwait, SupabaseMutationError } from "@/lib/db/safe-mutation";
import {
  applyStripePriceEdit,
  applySeatLadderEdit,
  PricingAdminError,
  type StripePriceEdit,
  type SeatLadderBand,
} from "@/lib/stripe/pricing-admin";
import type { TenantType, Tier, BillingPeriod, LineItem } from "@/lib/stripe/price-ids";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new PricingAdminError("stripe_not_configured", "STRIPE_SECRET_KEY not configured.");
  return new Stripe(key);
}

const TENANT_TYPES: readonly TenantType[] = ["sub_host", "byo_host"];
const TIERS: readonly Tier[] = ["starter", "pro", "agency"];
const PERIODS: readonly BillingPeriod[] = ["monthly", "annual"];
const LINE_ITEMS: readonly LineItem[] = ["base", "additional_seats"];

interface StripePricePutBody {
  kind: "stripe_price";
  tenant_type: TenantType;
  tier: Tier;
  billing_period: BillingPeriod;
  line_item: LineItem;
  amount_cents: number;
}

interface SeatLadderPutBody {
  kind: "seat_ladder";
  bands: SeatLadderBand[];
}

type PutBody = StripePricePutBody | SeatLadderPutBody;

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "pricing")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  try {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "pricing_read",
        operation: "pricing_read",
        reason_detail: "operator viewing subscription pricing",
      },
      async (db) => {
        const [tiers, priceMap, seatLadder] = await Promise.all([
          safeAwait(
            db.from("tier_definitions").select("code, base_price_monthly_cents, base_price_annual_cents"),
            "tier_definitions.select",
          ),
          safeAwait(
            db
              .from("stripe_price_map")
              .select("tenant_type, tier, billing_period, line_item, stripe_price_id, amount_cents, currency"),
            "stripe_price_map.select_all",
          ),
          safeAwait(
            db
              .from("pricing_seat_ladder")
              .select("up_to_seat, monthly_cents, annual_cents, sort_order")
              .order("sort_order", { ascending: true }),
            "pricing_seat_ladder.select",
          ),
        ]);
        return {
          tiers: tiers ?? [],
          price_map: priceMap ?? [],
          seat_ladder: seatLadder ?? [],
          stripe_configured: Boolean(process.env.STRIPE_SECRET_KEY),
        };
      },
    );
    return Response.json(result);
  } catch (err) {
    const ref = crypto.randomUUID();
    console.error("[pricing-admin] GET failed ref=%s", ref, err);
    return Response.json({ error: "db_error", ref }, { status: 500 });
  }
}

function validateStripePriceBody(body: StripePricePutBody): string | null {
  if (!TENANT_TYPES.includes(body.tenant_type)) return "tenant_type";
  if (!TIERS.includes(body.tier)) return "tier";
  if (!PERIODS.includes(body.billing_period)) return "billing_period";
  if (!LINE_ITEMS.includes(body.line_item)) return "line_item";
  if (!Number.isInteger(body.amount_cents) || body.amount_cents < 0) return "amount_cents";
  return null;
}

function errorResponse(err: unknown): Response {
  if (err instanceof PricingAdminError) {
    const status =
      err.code === "price_not_seeded" || err.code === "interval_mismatch" || err.code === "price_not_recurring"
        ? 409
        : err.code === "stripe_not_configured"
          ? 503
          : err.code.startsWith("invalid")
            ? 400
            : 502;
    return Response.json({ error: err.code }, { status });
  }
  if (err instanceof SupabaseMutationError) {
    // CAS guard tripped (concurrent edit) or a mutation failed.
    return Response.json({ error: "write_conflict" }, { status: 409 });
  }
  const ref = crypto.randomUUID();
  console.error("[pricing-admin] PUT failed ref=%s", ref, err);
  return Response.json({ error: "stripe_or_db_error", ref }, { status: 502 });
}

export async function PUT(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "pricing")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (body?.kind === "stripe_price") {
    const invalid = validateStripePriceBody(body);
    if (invalid) return Response.json({ error: "invalid_field", field: invalid }, { status: 400 });

    let stripe: Stripe;
    try {
      stripe = getStripe();
    } catch (e) {
      return errorResponse(e);
    }

    try {
      const result = await withPlatformAdminAudit(
        {
          admin_user_id: adminUserId,
          reason: "pricing_update",
          operation: "pricing_update",
          reason_detail: `${body.tenant_type}.${body.tier}.${body.billing_period}.${body.line_item}=${body.amount_cents}`,
        },
        (db) => applyStripePriceEdit(stripe, db, body as StripePriceEdit),
      );
      return Response.json({ ok: true, ...result });
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (body?.kind === "seat_ladder") {
    try {
      const result = await withPlatformAdminAudit(
        {
          admin_user_id: adminUserId,
          reason: "pricing_update",
          operation: "pricing_update",
          reason_detail: `seat_ladder bands=${Array.isArray(body.bands) ? body.bands.length : 0}`,
        },
        (db) => applySeatLadderEdit(db, body.bands),
      );
      return Response.json({ ok: true, ...result });
    } catch (err) {
      return errorResponse(err);
    }
  }

  return Response.json({ error: "invalid_kind" }, { status: 400 });
}
