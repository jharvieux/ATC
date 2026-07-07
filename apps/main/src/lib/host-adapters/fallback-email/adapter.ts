// §13.6 — Fallback email adapter implementing HostAgencyClient.
//
// Always-available adapter. Does no real host integration — emails structured
// booking details to HOST_ADAPTER_FALLBACK_EMAIL_TO via Resend's REST API.
// Returns a synthetic provider_booking_ref: 'EMAIL-{tenant_id}-{timestamp}'.
// Tenant admin manually updates with the real reference once the host confirms.
//
// All non-submitBooking operations return Err({ code: 'unsupported' }).

import { env } from "@/lib/env";
import { formatCents } from "@/lib/money";
import { Ok, Err } from "@atc/shared-types";
import type {
  HostAgencyClient,
  HostCapabilities,
  InventorySearchRequest,
  BookingSubmissionRequest,
  CancellationRequest,
  ModificationRequest,
  StatementFetchRequest,
  CommissionPaymentRequest,
  HostCallContext,
  HostAdapterError,
  Result,
} from "@atc/shared-types";

const UNSUPPORTED: Result<never, HostAdapterError> = Err({
  code: "unsupported",
  message: "Fallback email adapter does not support this operation.",
});

export default class FallbackEmailAdapter implements HostAgencyClient {
  readonly adapterId = "fallback-email";
  readonly displayName = "Manual / Email Fallback";
  readonly capabilities: HostCapabilities = {
    supports_inventory_search: false,
    supports_real_time_booking: true,
    supports_modification: false,
    supports_cancellation: false,
    supports_commission_api: false,
    supports_price_lock: false,
    booking_types: [],
    cruise_lines_supported: [],
    commission_currency: "USD",
    payment_lag_days_typical: 0,
  };

  describeCapabilities(): HostCapabilities {
    return this.capabilities;
  }

  async searchInventory(
    _req: InventorySearchRequest,
    _ctx: HostCallContext,
  ): Promise<Result<unknown, HostAdapterError>> {
    return UNSUPPORTED;
  }

  async submitBooking(
    req: BookingSubmissionRequest,
    ctx: HostCallContext,
  ): Promise<Result<{ provider_booking_ref: string; [key: string]: unknown }, HostAdapterError>> {
    const e = env();
    const to = e.HOST_ADAPTER_FALLBACK_EMAIL_TO;
    const from = e.HOST_ADAPTER_FALLBACK_EMAIL_FROM;
    const apiKey = e.RESEND_API_KEY;

    if (!to || !from || !apiKey) {
      return Err({
        code: "host_unavailable",
        message:
          "Fallback email adapter is not configured. " +
          "Set HOST_ADAPTER_FALLBACK_EMAIL_TO, HOST_ADAPTER_FALLBACK_EMAIL_FROM, and RESEND_API_KEY.",
      });
    }

    const timestamp = Date.now();
    const provider_booking_ref = `EMAIL-${ctx.tenant_id}-${timestamp}`;

    const body = [
      `New Booking Request — ${provider_booking_ref}`,
      ``,
      `Contact: ${req.contact_id}`,
      `Cruise Line: ${req.cruise_line}`,
      `Ship: ${req.ship_name}`,
      `Sailing Date: ${req.sailing_date}`,
      `Duration: ${req.duration_nights} nights`,
      `Cabin Category: ${req.cabin_category}`,
      `Passengers: ${req.passengers.length}`,
      `Total Amount: ${formatCents(req.total_amount_cents, req.currency)}`,
      `Commissionable Fare: ${formatCents(req.commissionable_fare_cents, req.currency)}`,
      req.special_requests ? `Special Requests: ${req.special_requests}` : null,
      ``,
      `Correlation ID: ${ctx.correlation_id}`,
      `Tenant: ${ctx.tenant_id}`,
      ``,
      `Please process this booking manually and update the platform reference once confirmed.`,
    ]
      .filter(Boolean)
      .join("\n");

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `Booking Request: ${provider_booking_ref}`,
        text: body,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return Err({
        code: "host_unavailable",
        message: `Resend API error ${res.status}: ${detail}`,
      });
    }

    return Ok({ provider_booking_ref });
  }

  async fetchBookingStatus(
    _ref: string,
    _ctx: HostCallContext,
  ): Promise<Result<unknown, HostAdapterError>> {
    return UNSUPPORTED;
  }

  async cancelBooking(
    _ref: string,
    _req: CancellationRequest,
    _ctx: HostCallContext,
  ): Promise<Result<void, HostAdapterError>> {
    return UNSUPPORTED;
  }

  async modifyBooking(
    _ref: string,
    _req: ModificationRequest,
    _ctx: HostCallContext,
  ): Promise<Result<unknown, HostAdapterError>> {
    return UNSUPPORTED;
  }

  async fetchCommissionStatement(
    _req: StatementFetchRequest,
    _ctx: HostCallContext,
  ): Promise<Result<unknown, HostAdapterError>> {
    return UNSUPPORTED;
  }

  async recordCommissionPayment(
    _req: CommissionPaymentRequest,
    _ctx: HostCallContext,
  ): Promise<Result<void, HostAdapterError>> {
    return UNSUPPORTED;
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    const e = env();
    if (!e.RESEND_API_KEY) {
      return { ok: false, message: "RESEND_API_KEY not configured." };
    }
    // Lightweight check: validate the key is accepted by Resend
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "OPTIONS",
        headers: { Authorization: `Bearer ${e.RESEND_API_KEY}` },
      });
      // Resend returns 200 or 405 for OPTIONS; either indicates reachability
      return { ok: res.status < 500 };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Resend unreachable.",
      };
    }
  }
}
