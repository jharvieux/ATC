// §7.6 / §14 — Shared column projection for /api/commissions reads.
// Single source of truth so a schema change touches one file.

export const COMMISSIONS_READ_COLUMNS =
  "id, tenant_id, booking_id, status, commissionable_fare_cents, " +
  "gross_commission_cents, net_commission_cents, " +
  "subhost_payable_cents, platform_retained_cents, " +
  "commission_rate, platform_split_rate, currency, " +
  "host_booking_fee_cents, host_booking_fee_rule_ref, " +
  "created_at, updated_at";
