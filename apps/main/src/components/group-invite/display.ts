import type { RosterEntry, ItineraryStop } from "./types";

// Maps roster.avatarColor (a palette token from lib/groups/roster.ts) to the
// cruise theme's actual CSS variables, keeping the palette-token/CSS-var
// mapping in one place rather than duplicating hex values here.
const AVATAR_COLOR_VARS: Record<string, string> = {
  "ocean-blue": "var(--cruise-accent)",
  "sun-yellow": "var(--cruise-sun)",
  coral: "var(--cruise-coral)",
  "success-green": "var(--cruise-success)",
};

export function avatarColorVar(color: string): string {
  return AVATAR_COLOR_VARS[color] ?? "var(--cruise-accent)";
}

// "Jenna R." -> "JR", "Anonymous" -> "?", "Cher" -> "C"
export function avatarInitials(entry: RosterEntry): string {
  if (entry.anonymous) return "?";
  const initials = entry.displayName
    .split(/\s+/)
    .map((word) => word[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("");
  return initials.toUpperCase() || "?";
}

// First name only, for the social-proof sentence ("Jenna, Mike, Priya + 11
// others") — the avatar circles carry the fuller "First L." via title/aria.
export function firstNameOnly(displayName: string): string {
  return displayName.split(" ")[0] ?? displayName;
}

export function daysUntil(sailingDateIso: string): number {
  const sailDate = new Date(sailingDateIso);
  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((sailDate.getTime() - now.getTime()) / msPerDay));
}

export function formatSailDate(sailingDateIso: string): string {
  return new Date(sailingDateIso).toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" });
}

// "{departurePort} → {stop1} → {stop2} → …", skipping the embarkation day
// (already shown as departurePort) and any sea days (no port to name).
export function routeSummary(departurePort: string, itinerary: ItineraryStop[] | null): string | null {
  if (!itinerary || itinerary.length === 0) return null;
  const stops = itinerary.slice(1).filter((s) => !s.isSeaDay).map((s) => s.portName);
  if (stops.length === 0) return null;
  return [departurePort, ...stops].join(" → ");
}
