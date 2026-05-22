// §11.5 — DOB lifecycle types and helpers.
//
// Estimated DOBs require periodic re-confirmation by the customer.
// The re-prompt cadence is: once per year from estimation_recorded_at,
// then once per year from estimation_last_reprompt_at. Estimated DOBs
// are suppressed from legally-sensitive surfaces (quote PDFs, pre-cruise emails).

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Storage shape for a single family-composition entry per §11.5. */
export interface FamilyMember {
  name?: string;
  relationship?: string;
  date_of_birth?: string | null;
  date_of_birth_is_estimated?: boolean;
  estimation_basis?: string | null;
  estimation_recorded_at?: string | null;
  estimation_last_reprompt_at?: string | null;
}

/**
 * Returns true when an estimated DOB is overdue for re-confirmation per §11.5.
 * Overdue = estimated AND recorded more than 365 days ago AND
 * (never re-prompted OR last re-prompt was more than 365 days ago).
 */
export function isEstimatedDOBOverdue(entry: FamilyMember): boolean {
  if (!entry.date_of_birth_is_estimated) return false;
  if (!entry.estimation_recorded_at) return false;

  const now = Date.now();
  const recordedAt = new Date(entry.estimation_recorded_at).getTime();
  if (isNaN(recordedAt) || now - recordedAt < ONE_YEAR_MS) return false;

  if (!entry.estimation_last_reprompt_at) return true;
  const lastReprompt = new Date(entry.estimation_last_reprompt_at).getTime();
  return !isNaN(lastReprompt) && now - lastReprompt >= ONE_YEAR_MS;
}

/**
 * Returns true when a family member's DOB should be suppressed from
 * legally-sensitive rendering surfaces (quote PDFs, pre-cruise emails) per §11.5.
 * Used by §23 pre-cruise email rendering and §12 quote PDF generator.
 */
export function suppressDOBContentForEstimated(entry: FamilyMember): boolean {
  return entry.date_of_birth_is_estimated === true;
}
