import type { ItineraryStop } from "./types";

function barColorFor(stop: ItineraryStop, index: number, total: number): string {
  if (index === 0 || index === total - 1) return "var(--cruise-accent)";
  if (stop.isSeaDay) return "var(--cruise-sun)";
  return "var(--cruise-coral)";
}

export function ItinerarySection({ itinerary }: { itinerary: ItineraryStop[] | null }) {
  if (!itinerary || itinerary.length === 0) return null;

  return (
    <div className="bg-[var(--cruise-bg)] px-10 pb-11">
      <div className="mb-3.5 font-[family-name:var(--font-quicksand)] text-xs font-bold uppercase tracking-[.08em] text-[var(--cruise-accent)]">
        {itinerary.length - 1}-Night Itinerary
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {itinerary.map((stop, i) => (
          <div
            key={`${stop.dayLabel}-${stop.portName}`}
            className="overflow-hidden rounded-[var(--cruise-radius-itinerary)] bg-[var(--cruise-surface)] shadow-[var(--cruise-card-shadow)]"
          >
            <div className="h-2" style={{ background: barColorFor(stop, i, itinerary.length) }} />
            <div className="p-3.5">
              <div className="font-[family-name:var(--font-quicksand)] text-xs font-bold text-[var(--cruise-accent)]">
                {stop.dayLabel.toUpperCase()}
              </div>
              <div className="mt-1 font-[family-name:var(--font-quicksand)] text-sm font-bold text-[var(--cruise-text)]">
                {stop.portName}
              </div>
              <div className="mt-0.5 text-xs font-medium text-[var(--cruise-text-muted)]">
                {stop.isSeaDay ? "At sea" : stop.arrival && stop.departure ? `${stop.arrival} – ${stop.departure}` : ""}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
