// Personal note the coordinator writes when creating/editing a group
// (groups.coordinator_message) — carried over from the pre-redesign page,
// which rendered it as a blockquote. Not part of design option 1b's sample
// layout, but dropping it would silently regress a real coordinator-facing
// feature, so it gets a small themed slot between the hero and the stats.
export function CoordinatorMessage({ message }: { message: string | null }) {
  if (!message) return null;

  return (
    <div className="bg-[var(--cruise-bg)] px-10 pt-9">
      <blockquote className="rounded-2xl border-l-4 border-[var(--cruise-accent)] bg-[var(--cruise-surface)] py-4 pl-5 pr-5 text-[15px] italic leading-[1.7] text-[var(--cruise-text)] shadow-[var(--cruise-card-shadow)]">
        {message}
      </blockquote>
    </div>
  );
}
