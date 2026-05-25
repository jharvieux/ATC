// BP34 §34.5.4 — Fuzzy match-confidence scoring for commission-statement
// line items that don't carry a `provider_booking_ref`.
//
// Weights (from spec §34.5.4):
//   cruise_line exact match     → 0.30
//   ship_name exact match       → 0.25
//   sailing_date exact match    → 0.25
//   sailing_date ±7 days        → 0.15  (if not already exact)
//   passenger_last_name exact   → 0.20
//   passenger_last_name fuzzy   → 0.10  (Levenshtein distance ≤ 2, if not already exact)
//
// Result thresholds:
//   ≥ 0.85  → high-confidence (auto-suggest in §14.8 review UI)
//   0.60–0.84 → possible match (require explicit admin confirmation)
//   < 0.60  → not surfaced; treated as orphan per §14.8
//
// All comparisons are case-insensitive + whitespace-normalised. Date
// inputs are ISO `YYYY-MM-DD` strings.

export interface MatchCandidate {
  cruise_line: string;
  ship_name: string;
  sailing_date: string;          // ISO YYYY-MM-DD
  passenger_last_name: string;
}

export type MatchOutcome = "high_confidence" | "possible" | "not_surfaced";

export interface MatchResult {
  confidence: number;            // 0..1, summed component weights
  outcome: MatchOutcome;
  components: {
    cruise_line: number;
    ship_name: number;
    sailing_date: number;
    passenger_last_name: number;
  };
}

const W_CRUISE_LINE_EXACT     = 0.30;
const W_SHIP_NAME_EXACT       = 0.25;
const W_SAIL_DATE_EXACT       = 0.25;
const W_SAIL_DATE_WITHIN_7D   = 0.15;
const W_LAST_NAME_EXACT       = 0.20;
const W_LAST_NAME_FUZZY       = 0.10;

const HIGH_CONFIDENCE_THRESHOLD = 0.85;
const POSSIBLE_MATCH_THRESHOLD  = 0.60;

function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(`${aIso}T00:00:00Z`).getTime();
  const b = new Date(`${bIso}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(a - b) / (1000 * 60 * 60 * 24);
}

/**
 * Levenshtein edit distance. Iterative DP, O(m*n) time, O(min(m,n)) space.
 * Returns Number.POSITIVE_INFINITY if either input exceeds 64 chars to
 * bound worst-case cost on adversarial inputs (passenger last names
 * shouldn't approach that length in any real dataset).
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  if (a.length > 64 || b.length > 64) return Number.POSITIVE_INFINITY;

  // Ensure a is the shorter string to bound row width.
  if (a.length > b.length) [a, b] = [b, a];

  let prev = new Array<number>(a.length + 1);
  let curr = new Array<number>(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;

  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        curr[i - 1]! + 1,
        prev[i]! + 1,
        prev[i - 1]! + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[a.length]!;
}

export function computeMatchConfidence(
  candidate: MatchCandidate,
  target: MatchCandidate,
): MatchResult {
  const cruise_line =
    norm(candidate.cruise_line) === norm(target.cruise_line)
      ? W_CRUISE_LINE_EXACT
      : 0;

  const ship_name =
    norm(candidate.ship_name) === norm(target.ship_name)
      ? W_SHIP_NAME_EXACT
      : 0;

  let sailing_date = 0;
  if (candidate.sailing_date === target.sailing_date) {
    sailing_date = W_SAIL_DATE_EXACT;
  } else if (daysBetween(candidate.sailing_date, target.sailing_date) <= 7) {
    sailing_date = W_SAIL_DATE_WITHIN_7D;
  }

  let passenger_last_name = 0;
  const aLast = norm(candidate.passenger_last_name);
  const bLast = norm(target.passenger_last_name);
  if (aLast && aLast === bLast) {
    passenger_last_name = W_LAST_NAME_EXACT;
  } else if (aLast && bLast && levenshtein(aLast, bLast) <= 2) {
    passenger_last_name = W_LAST_NAME_FUZZY;
  }

  const confidence =
    cruise_line + ship_name + sailing_date + passenger_last_name;

  const outcome: MatchOutcome =
    confidence >= HIGH_CONFIDENCE_THRESHOLD ? "high_confidence" :
    confidence >= POSSIBLE_MATCH_THRESHOLD  ? "possible" :
    "not_surfaced";

  return {
    confidence: Math.round(confidence * 1000) / 1000,
    outcome,
    components: { cruise_line, ship_name, sailing_date, passenger_last_name },
  };
}
