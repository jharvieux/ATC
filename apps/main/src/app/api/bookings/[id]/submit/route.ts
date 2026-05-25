// §14.3 / §14.4 — Booking submission with commission rate resolution.
//
// Fail-closed contract per §14.4:
//   - commission_rate unresolvable → no commissions row, booking → pending_host_review
//   - platform_split_rate unresolvable → same
//   - Both cases: alert platform admin via audit log, surface copy to tenant
//
// Commission computation order per §14.3 "Computation" (NOT multiply by (1 - rate)):
//   gross_commission_cents = multiplyRate(commissionable_fare_cents, commission_rate)
//   net_commission_cents   = subtractFee(gross_commission_cents, host_booking_fee_cents)
//   platform_retained_cents = multiplyRate(net_commission_cents, platform_split_rate)
//   subhost_payable_cents   = subtractFee(net_commission_cents, platform_retained_cents)

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { selectAdapterForCall } from "@/lib/host-adapters/select-adapter";
import { multiplyRate, subtractFee, toRate, type Cents } from "@/lib/money";
import { writeAuditLog } from "@/lib/audit/write";
import type { BookingSubmissionRequest } from "@atc/shared-types";

type BookingRow = {
  id: string;
  tenant_id: string;
  status: string;
  host_adapter: string | null;
  commissionable_fare_cents: bigint | null;
  total_amount_cents: bigint | null;
  currency: string;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  cabin_category: string | null;
  primary_contact_id: string | null;
};

type TenantRow = {
  id: string;
  prong: string;
  tier_id: string | null;
};

type TierRow = {
  id: string;
  platform_split_rate: number | null;
  hold_period_days: number;
};

type FeeConfigRow = {
  fee_type: string;
  fee_cents: number | null;
  fee_rate: number | null;
  rule_ref: string | null;
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "bookings", action: "submit" });
    const { id: bookingId } = await params;

    const db = tenantClient(ctx);
    const adminDb = createServiceRoleClient();

    // Load the booking
    const { data: bookingData, error: bookingError } = await db
      .from("bookings")
      .select(
        "id, tenant_id, status, host_adapter, commissionable_fare_cents, total_amount_cents, currency, cruise_line, ship_name, sailing_date, duration_nights, cabin_category, primary_contact_id",
      )
      .eq("id", bookingId)
      .single();

    if (bookingError || !bookingData) {
      return Response.json({ error: "Booking not found." }, { status: 404 });
    }

    const booking = bookingData as BookingRow;
    if (booking.status !== "draft") {
      return Response.json({ error: "Only draft bookings can be submitted." }, { status: 422 });
    }

    // §20.5 DOB confirmation gate — must clear before host adapter call
    const { assertNoEstimatedDOBs, DOBEstimateUnresolvedError } = await import("@/lib/booking/dob-gate");
    try {
      await assertNoEstimatedDOBs(bookingId);
    } catch (err) {
      if (err instanceof DOBEstimateUnresolvedError) {
        return Response.json({
          error: "estimated_dob_unresolved",
          affected_passengers: err.affectedPassengers,
        }, { status: 409 });
      }
      throw err;
    }

    // Load the tenant (to determine prong and tier)
    const { data: tenantData } = await adminDb
      .from("tenants")
      .select("id, prong, tier_id")
      .eq("id", ctx.tenant_id)
      .single();

    const tenant = tenantData as TenantRow | null;

    // Step 1: Resolve platform_split_rate from tier
    let platform_split_rate: number | null = null;
    let hold_period_days = 7;

    if (tenant?.tier_id) {
      const { data: tierData } = await adminDb
        .from("tier_definitions")
        .select("id, platform_split_rate, hold_period_days")
        .eq("id", tenant.tier_id)
        .single();

      if (tierData) {
        const tier = tierData as TierRow;
        platform_split_rate = tier.platform_split_rate;
        hold_period_days = tier.hold_period_days;
      }
    }

    // Step 2: Select adapter (with decrypted per-tenant credentials in ctx)
    // and check health. Audit pass 2, Finding 8: callers must use
    // selectAdapterForCall so the ctx passed to adapter methods carries
    // the tenant's actual credentials.
    const correlation_id = crypto.randomUUID();
    const { adapter, ctx: hostCtx } = await selectAdapterForCall(
      { id: ctx.tenant_id, prong: tenant?.prong ?? "byo_host" },
      { tenant_id: ctx.tenant_id, user_id: null, correlation_id },
    );

    const health = await adapter.healthCheck();

    // Step 3: Resolve commission_rate from adapter config or platform default
    let commission_rate: number | null = null;
    if (health.ok && adapter.capabilities.supports_commission_api) {
      // Try to get rate from the adapter's config stored in host_adapters
      const { data: adapterRow } = await adminDb
        .from("host_adapters")
        .select("config")
        .eq("adapter_id", adapter.adapterId)
        .maybeSingle();
      if (adapterRow) {
        const config = adapterRow.config as Record<string, unknown>;
        const rawRate = config["default_commission_rate"];
        if (typeof rawRate === "number") {
          commission_rate = rawRate;
        }
      }
    }

    // Step 4: Resolve booking fee from host_booking_fee_configs
    let host_booking_fee_cents = 0n as Cents;
    let host_booking_fee_rule_ref: string | null = null;

    const { data: feeConfig } = await adminDb
      .from("host_booking_fee_configs")
      .select("fee_type, fee_cents, fee_rate, rule_ref")
      .eq("adapter_id", adapter.adapterId)
      .maybeSingle();

    if (feeConfig) {
      const fee = feeConfig as FeeConfigRow;
      if (fee.fee_type === "flat" && fee.fee_cents != null) {
        host_booking_fee_cents = BigInt(fee.fee_cents) as Cents;
      } else if (
        fee.fee_type === "percent" &&
        fee.fee_rate != null &&
        booking.commissionable_fare_cents != null
      ) {
        host_booking_fee_cents = multiplyRate(
          BigInt(booking.commissionable_fare_cents),
          toRate(fee.fee_rate),
        ) as Cents;
      }
      host_booking_fee_rule_ref = fee.rule_ref;
    }

    // Check for tenant override
    const { data: feeOverride } = await db
      .from("tenant_host_fee_overrides")
      .select("fee_type, fee_cents, fee_rate, rule_ref")
      .eq("adapter_id", adapter.adapterId)
      .maybeSingle();

    if (feeOverride) {
      const fee = feeOverride as FeeConfigRow;
      if (fee.fee_type === "flat" && fee.fee_cents != null) {
        host_booking_fee_cents = BigInt(fee.fee_cents) as Cents;
      } else if (
        fee.fee_type === "percent" &&
        fee.fee_rate != null &&
        booking.commissionable_fare_cents != null
      ) {
        host_booking_fee_cents = multiplyRate(
          BigInt(booking.commissionable_fare_cents),
          toRate(fee.fee_rate),
        ) as Cents;
      }
      host_booking_fee_rule_ref = fee.rule_ref;
    }

    // §14.4 Fail-closed: if commission_rate or platform_split_rate is unresolvable, do NOT proceed
    if (commission_rate === null || !health.ok) {
      await db
        .from("bookings")
        .update({
          status: "pending_host_review",
          review_reason: health.ok ? "commission_rate_unresolvable" : "host_adapter_unhealthy",
          updated_at: new Date().toISOString(),
        })
        .eq("id", bookingId);

      logAuditStub({
        action: "booking.commission_rate_resolution",
        resource_id: bookingId,
        outcome: "failed",
        reason: health.ok ? "commission_rate_unresolvable" : "host_adapter_unhealthy",
        tenant_id: ctx.tenant_id,
      });

      return Response.json(
        {
          error:
            "Commission rate could not be resolved for this booking. " +
            "Your booking is pending review. Please contact support if this persists.",
          status: "pending_host_review",
        },
        { status: 503 },
      );
    }

    if (platform_split_rate === null) {
      await db
        .from("bookings")
        .update({
          status: "pending_host_review",
          review_reason: "missing_platform_split",
          updated_at: new Date().toISOString(),
        })
        .eq("id", bookingId);

      logAuditStub({
        action: "booking.commission_rate_resolution",
        resource_id: bookingId,
        outcome: "failed",
        reason: "missing_platform_split",
        tenant_id: ctx.tenant_id,
      });

      return Response.json(
        {
          error:
            "Platform commission split rate is not configured. " +
            "Your booking is pending review.",
          status: "pending_host_review",
        },
        { status: 503 },
      );
    }

    // §14.3 Commission computation
    const fare = BigInt(booking.commissionable_fare_cents ?? 0) as Cents;
    const commissionRate = toRate(commission_rate);
    const platformSplitRate = toRate(platform_split_rate);

    const gross_commission_cents = multiplyRate(fare, commissionRate);
    const net_commission_cents = subtractFee(gross_commission_cents, host_booking_fee_cents);
    const platform_retained_cents = multiplyRate(net_commission_cents, platformSplitRate);
    const subhost_payable_cents = subtractFee(net_commission_cents, platform_retained_cents);

    logAuditStub({
      action: "booking.commission_rate_resolution",
      resource_id: bookingId,
      outcome: "success",
      commission_rate,
      platform_split_rate,
      gross_commission_cents: gross_commission_cents.toString(),
      net_commission_cents: net_commission_cents.toString(),
      platform_retained_cents: platform_retained_cents.toString(),
      tenant_id: ctx.tenant_id,
    });

    // §21.10.1 — Quote pricing discipline.
    //
    // Look up the underlying accepted quote (if any). For ESTIMATE quotes,
    // call adapter.getCurrentPrice() and compare against the customer-accepted
    // variance. Outside variance → pending_customer_reconfirmation (no host
    // submission). CONFIRMED quotes proceed at the locked price.
    const { data: quoteData } = await db
      .from("quotes")
      .select(
        "id, price_kind, price_lock_token, price_lock_expires_at, locked_price_cents, estimate_price_cents, customer_accepted_variance_cents, customer_accepted_audit_id",
      )
      .eq("converted_to_booking_id", bookingId)
      .maybeSingle();

    const submitReqBase: BookingSubmissionRequest = {
      contact_id: booking.primary_contact_id ?? "unknown",
      cruise_line: booking.cruise_line ?? "",
      ship_name: booking.ship_name ?? "",
      sailing_date: booking.sailing_date ?? new Date().toISOString().slice(0, 10),
      duration_nights: booking.duration_nights ?? 0,
      cabin_category: booking.cabin_category ?? "",
      passengers: [],
      commissionable_fare_cents: Number(booking.commissionable_fare_cents ?? 0),
      total_amount_cents: Number(booking.total_amount_cents ?? 0),
      currency: booking.currency,
    };
    let submitReq: BookingSubmissionRequest = submitReqBase;

    if (quoteData) {
      const quote = quoteData as {
        id: string;
        price_kind: "estimate" | "confirmed" | null;
        price_lock_token: string | null;
        price_lock_expires_at: string | null;
        locked_price_cents: number | null;
        estimate_price_cents: number | null;
        customer_accepted_variance_cents: number | null;
        customer_accepted_audit_id: string | null;
      };

      if (quote.price_kind === "confirmed"
        && quote.price_lock_expires_at
        && new Date(quote.price_lock_expires_at) >= new Date()
        && quote.locked_price_cents != null
      ) {
        // CONFIRMED quote: submit at locked price.
        submitReq = { ...submitReqBase, total_amount_cents: quote.locked_price_cents };
      } else if (quote.price_kind === "estimate" && adapter.getCurrentPrice) {
        const priceResult = await adapter.getCurrentPrice(submitReqBase, hostCtx);
        if (priceResult.ok) {
          const hostCents = priceResult.value.total_cents;
          const estimateCents = quote.estimate_price_cents ?? submitReqBase.total_amount_cents;
          const allowedVariance = quote.customer_accepted_variance_cents ?? 0;
          const variance = Math.abs(hostCents - estimateCents);
          if (variance > allowedVariance) {
            // Pause for customer reconfirmation; do NOT submit to host.
            await db
              .from("bookings")
              .update({
                status: "pending_customer_reconfirmation",
                updated_at: new Date().toISOString(),
              })
              .eq("id", bookingId);
            logAuditStub({
              action: "quote.reconfirmation_requested",
              quote_id: quote.id,
              booking_id: bookingId,
              tenant_id: ctx.tenant_id,
              estimate_cents: estimateCents,
              host_cents: hostCents,
              variance_cents: variance,
              allowed_variance_cents: allowedVariance,
              prior_audit_id: quote.customer_accepted_audit_id,
            });
            return Response.json(
              {
                status: "pending_customer_reconfirmation",
                estimate_cents: estimateCents,
                host_cents: hostCents,
                variance_cents: variance,
                allowed_variance_cents: allowedVariance,
              },
              { status: 409 },
            );
          }
          // Within variance: submit at host price.
          submitReq = { ...submitReqBase, total_amount_cents: hostCents };
        }
        // If adapter.getCurrentPrice failed, fall through with the estimate
        // price as-is. The reconciliation cron catches drift after submit.
      }
    }

    const submitResult = await adapter.submitBooking(submitReq, hostCtx);

    if (!submitResult.ok) {
      // Leave booking in draft; return the adapter error
      return Response.json(
        { error: `Host adapter error: ${submitResult.error.message}`, code: submitResult.error.code },
        { status: 502 },
      );
    }

    const { provider_booking_ref } = submitResult.value;

    // Write commissions row with locked rates and fee snapshot
    const { error: commissionError } = await db.from("commissions").insert({
      tenant_id: ctx.tenant_id,
      booking_id: bookingId,
      commissionable_fare_cents: fare.toString(),
      commission_rate,
      platform_split_rate,
      gross_commission_cents: gross_commission_cents.toString(),
      host_booking_fee_cents: host_booking_fee_cents.toString(),
      host_booking_fee_rule_ref,
      net_commission_cents: net_commission_cents.toString(),
      platform_retained_cents: platform_retained_cents.toString(),
      subhost_payable_cents: subhost_payable_cents.toString(),
      currency: booking.currency,
      status: "expected",
    });

    if (commissionError) {
      return Response.json({ error: "Failed to record commission." }, { status: 500 });
    }

    // Transition booking to submitted
    await db
      .from("bookings")
      .update({
        status: "submitted",
        provider_booking_ref,
        host_adapter: adapter.adapterId,
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", bookingId);

    // §35.6 — populate conversion_touch_* on the booking from the
    // contact's most recent attribution touch. Per §35.6.2 this is read
    // fresh, NOT copied from any related quote (a booking weeks after
    // the quote should attribute to the most recent touch). Non-fatal.
    if (booking.primary_contact_id) {
      const { populateConversionTouch } = await import("@/lib/attribution/populate-conversion-touch");
      await populateConversionTouch({
        tenant_id: ctx.tenant_id,
        contact_id: booking.primary_contact_id,
        target_table: "bookings",
        target_id: bookingId,
        svc: adminDb,
      });
    }

    return Response.json({ ok: true, provider_booking_ref, status: "submitted" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unauthorized";
    return Response.json({ error: message }, { status: 401 });
  }
}

// BP26: legacy shim around writeAuditLog. Each caller passes a payload with
// `action` and `tenant_id`; the rest goes into `changes`. New callers should
// use writeAuditLog directly with explicit actor_type / resource_type.
function logAuditStub(payload: Record<string, unknown>): void {
  const { action, tenant_id, resource_id, ...rest } = payload as {
    action?: string;
    tenant_id?: string;
    resource_id?: string;
  };
  void writeAuditLog({
    tenant_id: typeof tenant_id === "string" ? tenant_id : null,
    actor_type: "system",
    action: typeof action === "string" ? action : "unknown",
    resource_type: "booking",
    resource_id: typeof resource_id === "string" ? resource_id : null,
    changes: rest as Record<string, unknown>,
  });
}
