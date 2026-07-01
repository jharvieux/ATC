import { avatarColorVar, avatarInitials, firstNameOnly } from "./display";
import type { CabinGrid, RosterEntry } from "./types";

interface StatsAndSocialProofProps {
  cabinGrid: CabinGrid;
  roster: RosterEntry[];
  onOpenGuestList: () => void;
}

function StatCard({ label, value, colorClass }: { label: string; value: number; colorClass: string }) {
  return (
    <div className="rounded-2xl bg-[var(--cruise-surface)] p-[22px] text-center shadow-[var(--cruise-card-shadow)]">
      <div className={`font-[family-name:var(--font-quicksand)] text-[34px] font-bold ${colorClass}`}>{value}</div>
      <div className="mt-1 text-[13px] font-semibold text-[var(--cruise-text-muted)]">{label}</div>
    </div>
  );
}

export function StatsAndSocialProof({ cabinGrid, roster, onOpenGuestList }: StatsAndSocialProofProps) {
  const booked = roster.filter((r) => r.status === "booked");
  const visibleAvatars = booked.slice(0, 4);
  const remainder = Math.max(0, booked.length - visibleAvatars.length);
  const namedFirstNames = booked.filter((r) => !r.anonymous).slice(0, 3).map((r) => firstNameOnly(r.displayName));
  const socialProofRemainder = Math.max(0, booked.length - namedFirstNames.length);

  return (
    <div className="bg-[var(--cruise-bg)] px-10 pb-2 pt-9">
      <div className="mb-7 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Booked" value={cabinGrid.booked} colorClass="text-[var(--cruise-success)]" />
        <StatCard label="Interested" value={cabinGrid.interested} colorClass="text-[#e8a017]" />
        <StatCard label="Pending" value={cabinGrid.pending} colorClass="text-[var(--cruise-text-muted)]" />
        <StatCard label="Can't make it" value={cabinGrid.not_going} colorClass="text-[var(--cruise-text-muted)] opacity-60" />
      </div>

      {booked.length > 0 ? (
        <button
          type="button"
          onClick={onOpenGuestList}
          className="mb-9 flex w-full items-center gap-3.5 rounded-2xl bg-[var(--cruise-surface)] p-4 px-5 text-left shadow-[var(--cruise-card-shadow)]"
        >
          <div className="flex">
            {visibleAvatars.map((entry, i) => (
              <div
                key={entry.id}
                title={entry.displayName}
                className="flex h-9 w-9 items-center justify-center rounded-[var(--cruise-radius-pill)] border-2 border-[var(--cruise-bg)] font-[family-name:var(--font-quicksand)] text-xs font-bold text-white"
                style={{ background: avatarColorVar(entry.avatarColor), marginLeft: i === 0 ? 0 : -10 }}
              >
                {avatarInitials(entry)}
              </div>
            ))}
            {remainder > 0 ? (
              <div
                className="flex h-9 w-9 items-center justify-center rounded-[var(--cruise-radius-pill)] border-2 border-[var(--cruise-bg)] bg-[var(--cruise-border)] font-[family-name:var(--font-quicksand)] text-[11px] font-bold text-[var(--cruise-text)]"
                style={{ marginLeft: -10 }}
              >
                +{remainder}
              </div>
            ) : null}
          </div>
          <div className="text-sm font-semibold text-[var(--cruise-text)]">
            {namedFirstNames.length > 0 ? (
              <>
                {namedFirstNames.join(", ")}
                {socialProofRemainder > 0 ? ` + ${socialProofRemainder} others` : ""} already booked. Come join the fun!
              </>
            ) : (
              <>{booked.length} guests already booked. Come join the fun!</>
            )}
          </div>
        </button>
      ) : null}
    </div>
  );
}
