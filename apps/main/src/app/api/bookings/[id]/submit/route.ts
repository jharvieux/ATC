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
import { selectAdapter } from "@/lib/host-adapters/select-adapter";
import { multiplyRate, subtractFee, toRate, type Cents } from "@/lib/money";
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

    // Step 2: Select adapter and check health
    const adapter = await selectAdapter({
      id: ctx.tenant_id,
      prong: tenant?.prong ?? "byo_host",
    });

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

    // Submit to host adapter
    const submitReq: BookingSubmissionRequest = {
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

    const submitResult = await adapter.submitBooking(submitReq, {
      tenant_id: ctx.tenant_id,
      user_id: null,
      correlation_id: crypto.randomUUID(),
    });

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

    return Response.json({ ok: true, provider_booking_ref, status: "submitted" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unauthorized";
    return Response.json({ error: message }, { status: 401 });
  }
}

// TODO(audit-log §26): replace with insert into public.audit_log
function logAuditStub(payload: Record<string, unknown>): void {
  console.warn("[audit-log:STUB] " + JSON.stringify({ ...payload, _stub: "§26" }));
}
