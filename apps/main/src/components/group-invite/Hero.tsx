import type { CruiseTheme } from "@/lib/group-invite/use-cruise-theme";
import { daysUntil, formatSailDate, routeSummary } from "./display";
import type { ItineraryStop } from "./types";

interface HeroProps {
  theme: CruiseTheme;
  shipName: string;
  nights: number;
  departurePort: string;
  sailingDate: string;
  itinerary: ItineraryStop[] | null;
}

export function Hero({ theme, shipName, nights, departurePort, sailingDate, itinerary }: HeroProps) {
  const route = routeSummary(departurePort, itinerary);

  return (
    <div
      className="relative overflow-hidden px-10 pb-16 pt-14"
      style={{ background: "var(--cruise-hero-gradient)" }}
    >
      <div
        className="absolute right-[60px] top-[34px] h-[74px] w-[74px] rounded-[var(--cruise-radius-pill)]"
        style={{
          background: theme === "dark" ? "#e8e8f0" : "var(--cruise-sun)",
          boxShadow: theme === "dark" ? "0 0 30px 8px rgba(232,232,240,.35)" : "0 0 40px 10px rgba(255,204,77,.5)",
        }}
      />
      <div
        className="absolute inset-x-0 -bottom-[30px] h-[60px] scale-x-[1.4] rounded-[50%_50%_0_0/100%_100%_0_0] bg-[var(--cruise-bg)]"
      />

      <div className="relative mb-[18px] inline-block rounded-[var(--cruise-radius-pill)] bg-white/60 px-3.5 py-[7px] font-[family-name:var(--font-quicksand)] text-xs font-bold uppercase tracking-[.05em] text-[var(--cruise-text)]">
        Group Cruise Invite
      </div>
      <h1 className="relative mb-3.5 max-w-[600px] font-[family-name:var(--font-quicksand)] text-[46px] font-bold leading-[1.1] text-[var(--cruise-text)]">
        You&rsquo;re invited aboard the {shipName}!
      </h1>
      <p className="relative mb-[26px] max-w-[560px] text-[17px] font-medium leading-[1.6] text-[var(--cruise-text)] opacity-80">
        {nights} nights aboard, departing {departurePort} on {formatSailDate(sailingDate)}.
      </p>
      <div className="relative flex flex-wrap items-center gap-4">
        <div className="whitespace-nowrap rounded-2xl bg-[var(--cruise-surface)] px-[18px] py-2.5 font-[family-name:var(--font-quicksand)] text-sm font-bold text-[var(--cruise-accent)]">
          {theme === "dark" ? "🌙" : "☀️"} {daysUntil(sailingDate)} days to set sail
        </div>
        {route ? (
          <div className="text-sm font-semibold text-[var(--cruise-text)] opacity-75">{route}</div>
        ) : null}
      </div>
    </div>
  );
}
