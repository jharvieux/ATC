// BP34 §34.3.3 — Shared types for the per-document-type field extractors.
//
// Each extractor returns the same shape:
//   - extracted: type-specific field bag (raw values, no validation yet)
//   - per_field_confidence: keyed by the same field names as `extracted`
//   - overall_confidence: minimum per-field confidence (§34.3.3 rule —
//     "one weak field pulls the whole record into review")
//
// The auto-accept layer (lib/import/auto-accept.ts) compares
// overall_confidence to the tenant's threshold and routes accordingly.

import type { DocumentType } from "../classifier";

export interface ExtractionResult<TFields = Record<string, unknown>> {
  extracted: TFields;
  per_field_confidence: Record<keyof TFields & string, number>;
  overall_confidence: number;
  error?: string;
}

/** Common shape — all extractors take the document text + tenant for cost attribution. */
export interface ExtractInput {
  tenant_id: string;
  text: string;
}

// ── Per-type field shapes (loose; validation layer enforces invariants) ──

export interface LeadNotificationFields {
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  interest_summary: string | null;
  destination: string | null;
  travel_window: string | null;          // freeform, e.g. "October 2026"
  party_size: number | null;
}

export interface BookingConfirmationFields {
  // SailingKey per §33.2 — required for §33.8 price-watch attachment.
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;           // ISO YYYY-MM-DD
  departure_port: string | null;
  duration_nights: number | null;
  // Booking-specific.
  provider_booking_ref: string | null;
  passenger_last_names: string[];
  total_amount_cents: number | null;
  currency: string | null;
  cabin_category: string | null;
  // Rate-resolution input (§34.7.3).
  commission_rate: number | null;        // e.g. 0.10 for 10%
  commission_amount_cents: number | null;
}

export interface CommissionStatementFields {
  statement_period_start: string | null;
  statement_period_end: string | null;
  line_items: Array<{
    provider_booking_ref: string | null;
    cruise_line: string | null;
    ship_name: string | null;
    sailing_date: string | null;
    passenger_last_name: string | null;
    commissionable_fare_cents: number | null;
    commission_rate: number | null;
    commission_amount_cents: number | null;
  }>;
}

export interface IntakeFormFields {
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  preferences: Record<string, string | number | boolean | null>;
}

export type ExtractedByType =
  | { type: "lead_notification"; result: ExtractionResult<LeadNotificationFields> }
  | { type: "booking_confirmation"; result: ExtractionResult<BookingConfirmationFields> }
  | { type: "commission_statement"; result: ExtractionResult<CommissionStatementFields> }
  | { type: "intake_form"; result: ExtractionResult<IntakeFormFields> }
  | { type: "unknown"; result: ExtractionResult<Record<string, never>> };

/** True if the document type has an extractor wired (everything except `unknown`). */
export function isExtractableType(t: DocumentType): t is Exclude<DocumentType, "unknown"> {
  return t !== "unknown";
}
