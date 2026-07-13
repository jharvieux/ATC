// §11.5 — DOB lifecycle types and helpers.
//
// Estimated DOBs require periodic re-confirmation by the customer.
// The re-prompt cadence (operator-confirmed 2026-05-26 / MEMORY D-087):
//   - Default: once every 30 days from estimation_recorded_at, then
//     once every 30 days from estimation_last_reprompt_at.
//   - Suppressed when the customer has an active booking with
//     sailing_date inside DOB_IMMINENT_BOOKING_WINDOW_DAYS — the
//     §20.5 submit gate handles those cases without redundant nagging.
//
// Spec phrasing was once-per-year; tightened in D-087 to surface
// estimated DOBs earlier for in-flight customers without spamming
// already-converted ones.
//
// Estimated DOBs are suppressed from legally-sensitive surfaces
// (quote PDFs, pre-cruise emails) regardless of cadence.

const DEFAULT_REPROMPT_INTERVAL_DAYS = 30;
const DEFAULT_IMMINENT_BOOKING_WINDOW_DAYS = 60;

export function repromptIntervalMs(): number {
  const raw = Number(process.env.DOB_REPROMPT_INTERVAL_DAYS ?? DEFAULT_REPROMPT_INTERVAL_DAYS);
  const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REPROMPT_INTERVAL_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

export function imminentBookingWindowMs(): number {
  const raw = Number(process.env.DOB_IMMINENT_BOOKING_WINDOW_DAYS ?? DEFAULT_IMMINENT_BOOKING_WINDOW_DAYS);
  const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IMMINENT_BOOKING_WINDOW_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

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
 * Returns true when an estimated DOB is overdue for re-confirmation per
 * §11.5 (operator-tightened cadence per MEMORY D-087).
 *
 * Overdue = estimated AND
 *   recorded more than DOB_REPROMPT_INTERVAL_DAYS ago (default 30d) AND
 *   (never re-prompted OR last re-prompt was more than DOB_REPROMPT_INTERVAL_DAYS ago).
 *
 * The booking-imminent suppression (T-60) is applied by the cron caller,
 * not here — this helper stays pure so it's straightforward to unit-test.
 * See `shouldRepromptForUser` for the cron-side combined check.
 */
export function isEstimatedDOBOverdue(entry: FamilyMember): boolean {
  if (!entry.date_of_birth_is_estimated) return false;
  if (!entry.estimation_recorded_at) return false;

  const now = Date.now();
  const intervalMs = repromptIntervalMs();
  const recordedAt = new Date(entry.estimation_recorded_at).getTime();
  if (isNaN(recordedAt) || now - recordedAt < intervalMs) return false;

  if (!entry.estimation_last_reprompt_at) return true;
  const lastReprompt = new Date(entry.estimation_last_reprompt_at).getTime();
  return !isNaN(lastReprompt) && now - lastReprompt >= intervalMs;
}

/**
 * §11.5 booking-imminent check: returns true when a sailing_date falls
 * inside DOB_IMMINENT_BOOKING_WINDOW_DAYS (default 60d) of now.
 *
 * The cron uses this to skip re-prompting a customer whose booking is
 * about to hit the §20.5 submit gate — that gate will surface the
 * estimated DOB to the customer; re-prompting via chat would be
 * redundant + noisy.
 */
export function isBookingImminent(sailingDateIso: string): boolean {
  const sailingMs = new Date(sailingDateIso).getTime();
  if (isNaN(sailingMs)) return false;
  const now = Date.now();
  if (sailingMs < now) return false; // past sailings are not imminent
  return sailingMs - now <= imminentBookingWindowMs();
}
