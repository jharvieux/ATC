// BP40 §40.3 / §40.9 — Per-type item_details validation + date-semantics check.

export type ItemType = "flight" | "hotel" | "transfer" | "excursion" | "insurance" | "other";

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

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
      // No additional structured checks in v1.
      break;
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
