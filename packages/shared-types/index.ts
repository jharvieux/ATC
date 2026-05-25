// Shared types across apps — populated as the schema is built out.
// See Build Prompt 03 for TenantContext and related types.

// ── §13.2 — HostAgencyClient interface ───────────────────────────────────────

export type BookingType = "cruise" | "land" | "air" | "hotel" | "package";

export type HostAdapterErrorCode =
  | "auth_failed"
  | "rate_limited"
  | "not_found"
  | "validation"
  | "host_unavailable"
  | "unsupported"
  | "internal";

export interface HostAdapterError {
  code: HostAdapterErrorCode;
  message: string;
}

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function Ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function Err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export interface HostCapabilities {
  supports_inventory_search: boolean;
  supports_real_time_booking: boolean;
  supports_modification: boolean;
  supports_cancellation: boolean;
  supports_commission_api: boolean;
  // §21.10.1 — when true, submitBooking/getCurrentPrice may return a
  // price_lock_token that locks the quote at the moment of pricing.
  // Used by quote-kind-resolver to decide ESTIMATE vs CONFIRMED.
  supports_price_lock: boolean;
  booking_types: BookingType[];
  cruise_lines_supported: string[];
  commission_currency: string;
  payment_lag_days_typical: number;
}

export interface HostCallContext {
  tenant_id: string;
  user_id: string | null;
  correlation_id: string;
  /**
   * Decrypted per-tenant credentials for the adapter to use. Populated by
   * `selectAdapterForCall` (apps/main/src/lib/host-adapters/select-adapter.ts)
   * for tenants that have a verified host config. Undefined for tenants on
   * the platform-default adapter or the fallback-email adapter.
   *
   * Adapter implementations MUST read credentials from here at call time
   * rather than holding them in instance state. The 2026-05-25 audit
   * (pass 2, Finding 8) flagged that the prior pattern (cache adapter
   * instance constructed with config, decrypt+discard tenant creds on each
   * call) meant the singleton adapter ran with platform-default creds for
   * every tenant.
   */
  credentials?: Record<string, unknown>;
}

export interface InventorySearchRequest {
  destination?: string;
  departure_port?: string;
  date_from?: string;
  date_to?: string;
  duration_nights_min?: number;
  duration_nights_max?: number;
  passenger_count?: number;
  cruise_lines?: string[];
  cabin_category?: string;
}

export interface BookingSubmissionRequest {
  quote_id?: string;
  contact_id: string;
  cruise_line: string;
  ship_name: string;
  sailing_date: string;
  duration_nights: number;
  cabin_category: string;
  passengers: Array<{
    first_name: string;
    last_name: string;
    date_of_birth?: string;
    passport_number?: string;
  }>;
  commissionable_fare_cents: number;
  total_amount_cents: number;
  currency: string;
  special_requests?: string;
}

export interface CancellationRequest {
  reason: string;
  requested_by: string;
}

export interface ModificationRequest {
  field: string;
  new_value: unknown;
  reason?: string;
}

export interface StatementFetchRequest {
  period_start: string;
  period_end: string;
  format?: "json" | "pdf" | "csv";
}

export interface CommissionPaymentRequest {
  booking_ref: string;
  amount_cents: number;
  currency: string;
  payment_date: string;
}

export interface HostAgencyClient {
  readonly adapterId: string;
  readonly displayName: string;
  readonly capabilities: HostCapabilities;

  searchInventory(req: InventorySearchRequest, ctx: HostCallContext): Promise<Result<unknown, HostAdapterError>>;
  submitBooking(req: BookingSubmissionRequest, ctx: HostCallContext): Promise<Result<{ provider_booking_ref: string; [key: string]: unknown }, HostAdapterError>>;
  // §21.10.1 — optional: fetch the current host price for a candidate booking,
  // used by the booking-submit handler to enforce ESTIMATE-quote variance.
  // Adapters that lack a live-price endpoint may omit this method; the handler
  // then proceeds without a variance check (i.e., trusts the quote price).
  getCurrentPrice?(req: BookingSubmissionRequest, ctx: HostCallContext): Promise<Result<{ total_cents: number; currency: string; price_lock_token?: string; price_lock_expires_at?: string }, HostAdapterError>>;
  fetchBookingStatus(ref: string, ctx: HostCallContext): Promise<Result<unknown, HostAdapterError>>;
  cancelBooking(ref: string, req: CancellationRequest, ctx: HostCallContext): Promise<Result<void, HostAdapterError>>;
  modifyBooking(ref: string, req: ModificationRequest, ctx: HostCallContext): Promise<Result<unknown, HostAdapterError>>;
  fetchCommissionStatement(req: StatementFetchRequest, ctx: HostCallContext): Promise<Result<unknown, HostAdapterError>>;
  recordCommissionPayment(req: CommissionPaymentRequest, ctx: HostCallContext): Promise<Result<void, HostAdapterError>>;
  healthCheck(): Promise<{ ok: boolean; message?: string }>;
  describeCapabilities(): HostCapabilities;
}
