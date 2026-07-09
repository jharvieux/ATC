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

export function formatDate(
  iso: string | number | Date | null | undefined,
  style: DateDisplayStyle = "numeric",
): string {
  if (iso == null) return "—";
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", STYLE_OPTIONS[style]);
}
