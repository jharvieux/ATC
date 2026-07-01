import type { ChatPreview } from "./types";

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.max(1, Math.round(ms / (60 * 60 * 1000)));
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

interface ChatPreviewCardProps {
  chatPreview: ChatPreview | null;
  chatHref: string;
}

export function ChatPreviewCard({ chatPreview, chatHref }: ChatPreviewCardProps) {
  return (
    <div className="bg-[var(--cruise-bg)] px-10 pb-11">
      <div className="mb-3.5 font-[family-name:var(--font-quicksand)] text-xs font-bold uppercase tracking-[.08em] text-[var(--cruise-accent)]">
        Group Chat
      </div>
      <div className="flex flex-col gap-3.5 rounded-[18px] bg-[var(--cruise-surface)] p-5 shadow-[var(--cruise-card-shadow)]">
        {!chatPreview || chatPreview.messages.length === 0 ? (
          <p className="text-sm font-medium text-[var(--cruise-text-muted)]">No messages yet — be the first to say hi.</p>
        ) : (
          chatPreview.messages.map((msg) => (
            <div key={msg.id} className="flex gap-3">
              <div className="flex h-8 w-8 flex-none items-center justify-center rounded-[var(--cruise-radius-pill)] bg-[var(--cruise-accent)] font-[family-name:var(--font-quicksand)] text-[11px] font-bold text-white">
                {msg.authorName.match(/[A-Za-z]/g)?.slice(0, 2).join("").toUpperCase() ?? "?"}
              </div>
              <div>
                <div className="text-[13px] font-bold text-[var(--cruise-text)]">
                  {msg.authorName} <span className="ml-1.5 text-xs font-medium text-[var(--cruise-text-muted)]">{relativeTime(msg.timestamp)}</span>
                </div>
                <div className="mt-0.5 text-sm font-medium text-[var(--cruise-text)] opacity-80">{msg.text}</div>
              </div>
            </div>
          ))
        )}
        {chatPreview ? (
          <div className="mt-1.5 flex items-center justify-between border-t border-[var(--cruise-border)] pt-3.5">
            <div className="text-[13px] font-semibold text-[var(--cruise-text-muted)]">
              {chatPreview.totalThisWeek} message{chatPreview.totalThisWeek === 1 ? "" : "s"} this week
            </div>
            <a
              href={chatHref}
              className="rounded-[var(--cruise-radius-pill)] bg-[var(--cruise-coral)] px-4 py-[9px] font-[family-name:var(--font-quicksand)] text-[13px] font-bold text-white"
            >
              Open Group Chat →
            </a>
          </div>
        ) : null}
      </div>
    </div>
  );
}
