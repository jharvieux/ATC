// BP40 §40.3 / §40.9 — Per-type item_details validation + date-semantics check.

// #1788 — shared cap for reads of booking_line_items. A booking (or the
// tenant-wide /api/line-items view) that has accumulated more rows than this
// silently truncates past PostgREST's default row cap without one.
export const MAX_BOOKING_LINE_ITEMS = 500;

export const ITEM_TYPES = ["flight", "hotel", "transfer", "excursion", "insurance", "other"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const LINE_ITEM_STATUSES = ["planned", "booked", "confirmed", "cancelled", "completed"] as const;
export type LineItemStatus = (typeof LINE_ITEM_STATUSES)[number];

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

// #2034 — per-type allowlist of permitted item_details keys, sourced verbatim
// from the §40.3 "item_details JSONB Shape by item_type" spec. item_details is
// accepted as free-form JSON (z.record(z.unknown())) at the API boundary, so
// without this any key — passenger names, DOB, policy numbers on the wrong
// type — could land in the blob and evade the CCPA data map. Keys NOT on the
// list for the item's type are rejected. `other` is a genuine catch-all with
// no spec shape: its item_details must stay empty (free text belongs in the
// first-class `description` column), so its allowlist is empty.
export const ITEM_DETAILS_ALLOWLIST: Record<ItemType, readonly string[]> = {
  flight: [
    "flight_number", "depart_airport", "arrive_airport", "depart_datetime", "arrive_datetime",
    "cabin_class", "is_round_trip", "return_depart_airport", "return_arrive_airport",
    "return_depart_datetime", "return_arrive_datetime",
  ],
  hotel: ["hotel_name", "room_type", "nights"],
  transfer: ["transfer_type", "pickup_location", "dropoff_location", "pickup_datetime"],
  excursion: ["excursion_name", "departure_time", "is_cruise_line_excursion"],
  insurance: ["policy_provider", "policy_number", "claims_url"],
  other: [],
};

export function validateLineItem(args: {
  item_type: ItemType;
  start_date: string | null;
  end_date: string | null;
  item_details: Record<string, unknown> | null;
}): ValidationResult {
  const errors: string[] = [];
  const { item_type, start_date, end_date, item_details } = args;

  if (start_date && end_date && Date.parse(start_date) > Date.parse(end_date)) {
    errors.push(`start_date (${start_date}) is after end_date (${end_date})`);
  }

  switch (item_type) {
    case "excursion":
      if (start_date && end_date && start_date !== end_date) {
        errors.push("excursion start_date and end_date must match (same activity day)");
      }
      break;
    case "flight":
      if (item_details) {
        const flight = item_details as { depart_airport?: unknown; arrive_airport?: unknown };
        if (!flight.depart_airport) errors.push("flight.item_details.depart_airport required");
        if (!flight.arrive_airport) errors.push("flight.item_details.arrive_airport required");
      }
      break;
    case "hotel":
      if (item_details) {
        const h = item_details as { hotel_name?: unknown; nights?: unknown };
        if (!h.hotel_name) errors.push("hotel.item_details.hotel_name required");
        if (start_date && end_date) {
          const nights = Math.round(
            (Date.parse(end_date) - Date.parse(start_date)) / (24 * 60 * 60 * 1000),
          );
          if (nights < 1) errors.push("hotel must have at least 1 night between check-in/out");
        }
      }
      break;
    case "transfer":
    case "insurance":
    case "other":
      // Structural shape enforced by the allowlist below (no required fields).
      break;
  }

  // #2034 — allowlist gate: reject any item_details key not defined for this
  // type in §40.3. Applies to every type (flight/hotel keep their required-field
  // checks above AND get key-allowlisting here) so PII can't hide in the blob.
  if (item_details) {
    const allowed = ITEM_DETAILS_ALLOWLIST[item_type];
    const unpermitted = Object.keys(item_details).filter((k) => !allowed.includes(k));
    if (unpermitted.length > 0) {
      errors.push(`${item_type}.item_details has unpermitted keys: ${unpermitted.join(", ")}`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// §40.4.1 — compute expected_commission_cents when commissionable + rate set.
export function computeExpectedCommissionCents(args: {
  commissionable: boolean;
  customer_cost_cents: number;
  commission_rate: number | null;
}): number | null {
  if (!args.commissionable) return null;
  if (args.commission_rate === null) return null;
  return Math.round(args.customer_cost_cents * args.commission_rate);
}
