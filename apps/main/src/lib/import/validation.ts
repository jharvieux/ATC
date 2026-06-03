// BP34 §34.3.4 — validation layer.
//
// Three checks per the spec:
//   1. Required-field presence per document type.
//   2. Plausibility (sailing_date not in the past, currency present when
//      money is, commission_rate within sane bounds, etc).
//   3. Duplicate detection (provider_booking_ref already on file for this
//      tenant → flag for review, never auto-accept).
//
// Returns the list of flags. An empty list means "no validation
// concerns, free to auto-accept if confidence is above threshold."

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BookingConfirmationFields,
  CommissionStatementFields,
  IntakeFormFields,
  LeadNotificationFields,
} from "./extractors/types";

export type ValidationFlag = {
  flag: string;
  reason: string;
};

export type ValidationInput =
  | { type: "lead_notification"; tenant_id: string; fields: LeadNotificationFields }
  | { type: "booking_confirmation"; tenant_id: string; fields: BookingConfirmationFields }
  | { type: "commission_statement"; tenant_id: string; fields: CommissionStatementFields }
  | { type: "intake_form"; tenant_id: string; fields: IntakeFormFields };

export async function validate(
  input: ValidationInput,
  db: Pick<SupabaseClient, "from">,
): Promise<ValidationFlag[]> {
  switch (input.type) {
    case "lead_notification":
      return validateLead(input.fields);
    case "booking_confirmation":
      return validateBooking(input.fields, input.tenant_id, db);
    case "commission_statement":
      return validateStatement(input.fields);
    case "intake_form":
      return validateIntake(input.fields);
  }
}

// ── lead_notification ────────────────────────────────────────────────────
function validateLead(f: LeadNotificationFields): ValidationFlag[] {
  const flags: ValidationFlag[] = [];

  // Required: at least one of contact_email/contact_phone, and a name.
  if (!f.contact_name) {
    flags.push({ flag: "missing_required", reason: "contact_name absent" });
  }
  if (!f.contact_email && !f.contact_phone) {
    flags.push({ flag: "missing_required", reason: "neither contact_email nor contact_phone present" });
  }
  if (f.contact_email && !isPlausibleEmail(f.contact_email)) {
    flags.push({ flag: "implausible_value", reason: `contact_email "${f.contact_email}" does not look like a valid address` });
  }
  if (f.party_size !== null && (f.party_size < 1 || f.party_size > 50)) {
    flags.push({ flag: "implausible_value", reason: `party_size ${f.party_size} outside plausible range 1..50` });
  }

  return flags;
}

// ── booking_confirmation ─────────────────────────────────────────────────
async function validateBooking(
  f: BookingConfirmationFields,
  tenantId: string,
  db: Pick<SupabaseClient, "from">,
): Promise<ValidationFlag[]> {
  const flags: ValidationFlag[] = [];

  // SailingKey required (§33.2) for price-watch + statement matching.
  const required: Array<[keyof BookingConfirmationFields, string]> = [
    ["cruise_line", "cruise_line absent"],
    ["ship_name", "ship_name absent"],
    ["sailing_date", "sailing_date absent"],
    ["departure_port", "departure_port absent"],
    ["duration_nights", "duration_nights absent"],
    ["provider_booking_ref", "provider_booking_ref absent"],
    ["total_amount_cents", "total_amount_cents absent"],
  ];
  for (const [k, reason] of required) {
    if (f[k] === null || f[k] === undefined) {
      flags.push({ flag: "missing_required", reason });
    }
  }

  // Plausibility.
  if (f.sailing_date && Date.parse(f.sailing_date) < Date.now() - 24 * 60 * 60 * 1000) {
    flags.push({ flag: "implausible_value", reason: `sailing_date ${f.sailing_date} is in the past` });
  }
  if (f.total_amount_cents !== null && f.total_amount_cents <= 0) {
    flags.push({ flag: "implausible_value", reason: `total_amount_cents ${f.total_amount_cents} must be positive` });
  }
  if (f.total_amount_cents !== null && !f.currency) {
    flags.push({ flag: "missing_required", reason: "currency absent when total_amount_cents present" });
  }
  if (f.commission_rate !== null && (f.commission_rate < 0 || f.commission_rate > 0.5)) {
    flags.push({ flag: "implausible_value", reason: `commission_rate ${f.commission_rate} outside plausible 0..0.5 range` });
  }
  if (f.duration_nights !== null && (f.duration_nights < 1 || f.duration_nights > 365)) {
    flags.push({ flag: "implausible_value", reason: `duration_nights ${f.duration_nights} outside plausible 1..365` });
  }

  // Duplicate detection: provider_booking_ref already on file for this tenant.
  if (f.provider_booking_ref) {
    const { data, error } = await db
      .from("bookings")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("provider_booking_ref", f.provider_booking_ref)
      .limit(1);

    if (error) {
      flags.push({ flag: "duplicate_check_failed", reason: `dup-check query failed: ${error.message}` });
    } else if (data && data.length > 0 && data[0]) {
      flags.push({
        flag: "duplicate_provider_booking_ref",
        reason: `provider_booking_ref "${f.provider_booking_ref}" already exists on booking ${data[0].id}`,
      });
    }
  }

  return flags;
}

// ── commission_statement ─────────────────────────────────────────────────
function validateStatement(f: CommissionStatementFields): ValidationFlag[] {
  const flags: ValidationFlag[] = [];

  if (!f.statement_period_start) {
    flags.push({ flag: "missing_required", reason: "statement_period_start absent" });
  }
  if (!f.statement_period_end) {
    flags.push({ flag: "missing_required", reason: "statement_period_end absent" });
  }
  if (
    f.statement_period_start &&
    f.statement_period_end &&
    Date.parse(f.statement_period_start) > Date.parse(f.statement_period_end)
  ) {
    flags.push({
      flag: "implausible_value",
      reason: `statement_period_start ${f.statement_period_start} after statement_period_end ${f.statement_period_end}`,
    });
  }
  if (f.line_items.length === 0) {
    flags.push({ flag: "missing_required", reason: "no line_items extracted from statement" });
  }

  let badRows = 0;
  for (const row of f.line_items) {
    if (!row.provider_booking_ref || row.commission_amount_cents === null) badRows++;
  }
  if (badRows > 0) {
    flags.push({
      flag: "line_items_incomplete",
      reason: `${badRows} of ${f.line_items.length} line_items missing provider_booking_ref or commission_amount_cents`,
    });
  }

  // Commission statements ALWAYS route to review for §14.8 matching —
  // they affect ledger state and we want a human in the loop on first
  // touch. Auto-accept routing layer enforces this; we just flag here so
  // it shows up in the review queue context.
  flags.push({ flag: "requires_human_review", reason: "all commission statements route to manual review (§14.8)" });

  return flags;
}

// ── intake_form ──────────────────────────────────────────────────────────
function validateIntake(f: IntakeFormFields): ValidationFlag[] {
  const flags: ValidationFlag[] = [];

  if (!f.contact_name) {
    flags.push({ flag: "missing_required", reason: "contact_name absent" });
  }
  if (!f.contact_email && !f.contact_phone) {
    flags.push({ flag: "missing_required", reason: "neither contact_email nor contact_phone present" });
  }
  if (f.contact_email && !isPlausibleEmail(f.contact_email)) {
    flags.push({ flag: "implausible_value", reason: `contact_email "${f.contact_email}" does not look like a valid address` });
  }
  if (Object.keys(f.preferences).length === 0) {
    flags.push({ flag: "missing_required", reason: "intake form yielded zero preferences fields" });
  }

  return flags;
}

// ── shared ───────────────────────────────────────────────────────────────
function isPlausibleEmail(s: string): boolean {
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
