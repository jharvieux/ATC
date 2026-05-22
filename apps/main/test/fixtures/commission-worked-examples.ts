// §12.7 — Commission math worked examples.
// Tests are skipped (it.skip) until Part 4 implements the runtime commission math.
// These fixtures define the expected outputs that the math library MUST satisfy.

export interface CommissionWorkInput {
  commissionable_fare_cents: number;
  host_commission_rate_basis_points: number;
  host_booking_fee_type: "none" | "flat" | "percent" | "tiered";
  host_booking_fee_amount_cents?: number;
  host_booking_fee_percent?: number;
  tenant_type: string;
  tenant_tier: string;
  platform_share_basis_points: number;
}

export interface CommissionWorkExpected {
  gross_commission_cents: number;
  host_fee_deduction_cents: number;
  net_to_platform_cents: number;
  platform_take_cents: number;
  tenant_retains_cents: number;
}

export interface CommissionWorkedExample {
  label: string;
  inputs: CommissionWorkInput;
  expected: CommissionWorkExpected;
}

export const workedExamples: CommissionWorkedExample[] = [
  {
    label: "§12.7 — $5000 fare, 15% commission, $25 flat host fee, sub-host Pro 20/80",
    inputs: {
      commissionable_fare_cents: 500000,
      host_commission_rate_basis_points: 1500,
      host_booking_fee_type: "flat",
      host_booking_fee_amount_cents: 2500,
      tenant_type: "sub_host",
      tenant_tier: "sub_pro",
      platform_share_basis_points: 2000,
    },
    expected: {
      gross_commission_cents: 75000,
      host_fee_deduction_cents: 2500,
      net_to_platform_cents: 72500,
      platform_take_cents: 14500,
      tenant_retains_cents: 58000,
    },
  },
  {
    label: "§12.7 — $5000 fare, 15% commission, 2% percent host fee, sub-host Pro 20/80",
    inputs: {
      commissionable_fare_cents: 500000,
      host_commission_rate_basis_points: 1500,
      host_booking_fee_type: "percent",
      host_booking_fee_percent: 0.02,
      tenant_type: "sub_host",
      tenant_tier: "sub_pro",
      platform_share_basis_points: 2000,
    },
    expected: {
      gross_commission_cents: 75000,
      host_fee_deduction_cents: 1500,   // 2% of 75000
      net_to_platform_cents: 73500,
      platform_take_cents: 14700,
      tenant_retains_cents: 58800,
    },
  },
  {
    label: "§12.7 — $5000 fare, 15% commission, no host fee, sub-host Starter 20/80",
    inputs: {
      commissionable_fare_cents: 500000,
      host_commission_rate_basis_points: 1500,
      host_booking_fee_type: "none",
      tenant_type: "sub_host",
      tenant_tier: "sub_starter",
      platform_share_basis_points: 2000,
    },
    expected: {
      gross_commission_cents: 75000,
      host_fee_deduction_cents: 0,
      net_to_platform_cents: 75000,
      platform_take_cents: 15000,
      tenant_retains_cents: 60000,
    },
  },
  {
    label: "§12.7 — $10000 fare, 12% commission, $25 flat host fee, byo-host 0/100 split",
    inputs: {
      commissionable_fare_cents: 1000000,
      host_commission_rate_basis_points: 1200,
      host_booking_fee_type: "flat",
      host_booking_fee_amount_cents: 2500,
      tenant_type: "byo_host",
      tenant_tier: "byo_professional",
      platform_share_basis_points: 0,
    },
    expected: {
      gross_commission_cents: 120000,
      host_fee_deduction_cents: 2500,
      net_to_platform_cents: 117500,
      platform_take_cents: 0,
      tenant_retains_cents: 117500,
    },
  },
];
