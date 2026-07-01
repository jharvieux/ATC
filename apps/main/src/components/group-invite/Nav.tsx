import { CruiseThemeToggle } from "./CruiseThemeToggle";
import { avatarColorVar, avatarInitials } from "./display";
import type { RosterEntry } from "./types";

interface NavProps {
  cruiseLine: string;
  sailingYear: number;
  organizers: RosterEntry[];
  tenantLogoUrl?: string | null;
}

export function Nav({ cruiseLine, sailingYear, organizers, tenantLogoUrl }: NavProps) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--cruise-border)] bg-[var(--cruise-surface)] px-10 py-[22px]">
      <div className="flex items-center gap-2.5">
        {tenantLogoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={tenantLogoUrl} alt="" className="h-[30px] w-[30px] rounded-[9px] object-contain" />
        ) : (
          <div
            className="h-[30px] w-[30px] rounded-[9px]"
            style={{ background: "linear-gradient(135deg,var(--cruise-accent),var(--cruise-sun))" }}
          />
        )}
        <span className="font-[family-name:var(--font-quicksand)] text-[15px] font-bold tracking-[.01em] text-[var(--cruise-text)]">
          {cruiseLine} Group Cruise · {sailingYear}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {organizers.slice(0, 2).map((entry) => (
          <div
            key={entry.id}
            title={entry.displayName}
            className="flex h-8 w-8 items-center justify-center rounded-[var(--cruise-radius-pill)] font-[family-name:var(--font-quicksand)] text-xs font-bold text-white"
            style={{ background: avatarColorVar(entry.avatarColor) }}
          >
            {avatarInitials(entry)}
          </div>
        ))}
        <CruiseThemeToggle />
      </div>
    </div>
  );
}
