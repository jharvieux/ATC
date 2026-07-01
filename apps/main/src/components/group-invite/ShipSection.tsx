import type { ShipStats } from "./types";

interface ShipSectionProps {
  shipName: string;
  heroImageUrl: string | null;
  shipStats: ShipStats | null;
}

function StatTile({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="rounded-[var(--cruise-radius-itinerary)] bg-[var(--cruise-surface)] p-4 shadow-[var(--cruise-card-shadow)]">
      <div className="font-[family-name:var(--font-quicksand)] text-xl font-bold text-[var(--cruise-text)]">{value}</div>
      <div className="text-xs font-semibold text-[var(--cruise-text-muted)]">{label}</div>
    </div>
  );
}

export function ShipSection({ shipName, heroImageUrl, shipStats }: ShipSectionProps) {
  const tiles: { value: string | number; label: string }[] = [];
  if (shipStats?.guestCapacity != null) tiles.push({ value: shipStats.guestCapacity.toLocaleString(), label: "Guests aboard" });
  if (shipStats?.decks != null) tiles.push({ value: shipStats.decks, label: "Decks" });
  if (shipStats?.signatureFeature) tiles.push({ value: shipStats.signatureFeature, label: "Signature feature" });
  if (shipStats?.builtYear != null) tiles.push({ value: shipStats.builtYear, label: "Built" });

  if (!heroImageUrl && tiles.length === 0) return null;

  return (
    <div className="bg-[var(--cruise-bg)] px-10 pb-11">
      <div className="mb-2.5 font-[family-name:var(--font-quicksand)] text-xs font-bold uppercase tracking-[.08em] text-[var(--cruise-accent)]">
        The Ship
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1.1fr_1fr]">
        <div
          className="relative flex min-h-[170px] items-end overflow-hidden rounded-2xl p-4"
          style={{ background: "linear-gradient(135deg,var(--cruise-hero-gradient))" }}
        >
          {heroImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={heroImageUrl} alt={shipName} className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <span className="relative text-xs font-semibold text-white/85">[ {shipName} — hero photo ]</span>
          )}
        </div>
        {tiles.length > 0 ? (
          <div className="grid grid-cols-2 gap-3">
            {tiles.map((tile) => (
              <StatTile key={tile.label} value={tile.value} label={tile.label} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
