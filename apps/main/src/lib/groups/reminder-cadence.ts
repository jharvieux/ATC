// §18.8 — Reminder cadence interval selection for pending group invitations.
//
// Cadence per months-before-sailing:
//   24+ months → every 6 weeks (42 days)
//   12–24 months → monthly    (30 days)
//   6–12 months → every 2 wks (14 days)
//   1–6 months  → weekly      (7 days)
//   <1 month    → null (final 30 days — "last chance" logic only, no automated weeklies)

export function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

export function cadenceIntervalDays(monthsUntilSailing: number): number | null {
  if (monthsUntilSailing >= 24) return 42;
  if (monthsUntilSailing >= 12) return 30;
  if (monthsUntilSailing >= 6)  return 14;
  if (monthsUntilSailing >= 1)  return 7;
  return null;
}
