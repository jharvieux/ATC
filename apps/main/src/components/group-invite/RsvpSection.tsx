interface RsvpSectionProps {
  rsvpState: string;
  isAnonymous: boolean;
  isSailed: boolean;
  pending: boolean;
  onRsvpChange: (state: "interested" | "not_going" | "booked") => void;
  onAnonymousChange: (anonymous: boolean) => void;
}

const OPTIONS: { state: "interested" | "not_going" | "booked"; label: string }[] = [
  { state: "interested", label: "I'm Interested" },
  { state: "not_going", label: "Can't Make It" },
  { state: "booked", label: "I've Booked" },
];

export function RsvpSection({ rsvpState, isAnonymous, isSailed, pending, onRsvpChange, onAnonymousChange }: RsvpSectionProps) {
  return (
    <div className="border-t border-[var(--cruise-border)] bg-[var(--cruise-surface)] px-10 pb-12 pt-11">
      <h2 className="mb-1.5 font-[family-name:var(--font-quicksand)] text-2xl font-bold text-[var(--cruise-text)]">
        Will you be joining us?
      </h2>
      {isSailed ? (
        <p className="text-sm font-medium text-[var(--cruise-text-muted)]">
          This trip has sailed. RSVP changes are no longer accepted.
        </p>
      ) : (
        <>
          <p className="mb-[22px] text-sm font-medium text-[var(--cruise-text-muted)]">
            Let the group know your status — you can always change it later.
          </p>
          <div className="flex flex-wrap gap-3.5">
            {OPTIONS.map((opt) => {
              const selected = rsvpState === opt.state;
              return (
                <button
                  key={opt.state}
                  type="button"
                  disabled={pending}
                  onClick={() => onRsvpChange(opt.state)}
                  className={`rounded-[var(--cruise-radius-pill)] px-5 py-2.5 font-[family-name:var(--font-quicksand)] text-sm font-bold transition-opacity disabled:opacity-60 ${
                    selected
                      ? "bg-[var(--cruise-accent)] text-white"
                      : "border border-[var(--cruise-border)] bg-transparent text-[var(--cruise-text)]"
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm font-medium text-[var(--cruise-text-muted)]">
            <input
              type="checkbox"
              checked={isAnonymous}
              disabled={pending}
              onChange={(e) => onAnonymousChange(e.target.checked)}
            />
            RSVP anonymously
          </label>
        </>
      )}
    </div>
  );
}
