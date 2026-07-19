// Canonical date-display helper (#1610). Scattered call sites used
// locale-less `toLocaleDateString()` — some explicit "en-US", others not.
// The locale-less ones default to the runtime's ambient locale, which
// differs between the SSR server and the browser and causes hydration
// mismatches. This always passes an explicit locale.

export type DateDisplayStyle = "numeric" | "short" | "medium" | "long";

const STYLE_OPTIONS: Record<DateDisplayStyle, Intl.DateTimeFormatOptions | undefined> = {
  numeric: undefined, // e.g. "1/5/2026"
  short: { month: "short", day: "numeric" }, // e.g. "Jan 5"
  medium: { month: "short", day: "numeric", year: "numeric" }, // e.g. "Jan 5, 2026"
  long: { weekday: "long", month: "long", day: "numeric" }, // e.g. "Monday, January 5"
};

// Date-only strings ("2026-07-06", a Postgres DATE column like sailing_date)
// parse as UTC midnight per the ISO 8601 spec, but toLocaleDateString renders
// in the browser's local timezone — a negative-UTC-offset browser rolls that
// back to the previous calendar day. Render these in UTC so the displayed
// date matches the stored date everywhere (#1768).
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function formatDate(
  iso: string | number | Date | null | undefined,
  style: DateDisplayStyle = "numeric",
  // Explicit override for callers (tests, primarily) that need a deterministic
  // zone instead of the runtime's ambient one. Ignored for date-only strings,
  // which always render in UTC per #1768 — see DATE_ONLY comment above.
  timeZone?: string,
): string {
  if (iso == null) return "—";
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const options = typeof iso === "string" && DATE_ONLY.test(iso)
    ? { ...STYLE_OPTIONS[style], timeZone: "UTC" }
    : timeZone
      ? { ...STYLE_OPTIONS[style], timeZone }
      : STYLE_OPTIONS[style];
  return date.toLocaleDateString("en-US", options);
}
