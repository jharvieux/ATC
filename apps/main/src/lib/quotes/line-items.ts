// BP38 §38.5 — Line-item validation.
//
// Categories must come from the §12.5 commissionable-fare table. Sum of
// line_items.amount_cents must equal option's total_amount_cents (within
// a $1 tolerance per §38.10), and sum of commissionable items must equal
// commissionable_fare_cents.

export const VALID_CATEGORIES = [
  "base_fare",
  "cabin_upgrade",
  "loyalty_discount",
  "taxes_fees",
  "gratuities",
  "insurance",
  "dining",
  "beverage_package",
  "excursion",
  "other",
] as const;

export type LineItemCategory = (typeof VALID_CATEGORIES)[number];

export interface LineItem {
  description: string;
  amount_cents: number;
  is_commissionable: boolean;
  category: LineItemCategory;
}

export interface OptionFinancials {
  total_amount_cents: number;
  commissionable_fare_cents: number;
}

const TOLERANCE_CENTS = 100; // $1.00 per §38.10

export type ValidationError = { ok: false; errors: string[] };
export type ValidationOk = { ok: true };

export function validateLineItems(
  items: LineItem[],
  financials: OptionFinancials,
): ValidationOk | ValidationError {
  const errors: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (!it.description || it.description.trim().length === 0) {
      errors.push(`item[${i}].description required`);
    }
    if (typeof it.amount_cents !== "number" || !Number.isInteger(it.amount_cents)) {
      errors.push(`item[${i}].amount_cents must be integer`);
    }
    if (typeof it.is_commissionable !== "boolean") {
      errors.push(`item[${i}].is_commissionable must be boolean`);
    }
    if (!VALID_CATEGORIES.includes(it.category)) {
      errors.push(`item[${i}].category "${it.category}" not in allowed set`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const sumAll = items.reduce((s, it) => s + it.amount_cents, 0);
  const sumCommish = items.filter((it) => it.is_commissionable).reduce((s, it) => s + it.amount_cents, 0);

  if (Math.abs(sumAll - financials.total_amount_cents) > TOLERANCE_CENTS) {
    errors.push(
      `line items sum to ${sumAll} cents but total_amount_cents is ${financials.total_amount_cents} (tolerance ±${TOLERANCE_CENTS})`,
    );
  }
  if (Math.abs(sumCommish - financials.commissionable_fare_cents) > TOLERANCE_CENTS) {
    errors.push(
      `commissionable line items sum to ${sumCommish} cents but commissionable_fare_cents is ${financials.commissionable_fare_cents} (tolerance ±${TOLERANCE_CENTS})`,
    );
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
