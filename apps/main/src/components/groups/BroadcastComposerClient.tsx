"use client";

// §18.6 — Coordinator broadcast composer. Subject + message + RSVP-state
// recipient checkboxes → POST /api/groups/[id]/broadcast.
// Default states: interested + booked (mirrors the backend default).
//
// Restyled to the group-landing "Bright & Vacation-y" cruise identity
// (specs/design_handoff_group_landing/) — raw elements + --cruise-* tokens
// instead of shadcn Button/Input/Label/Textarea (which hardcode the app-wide
// indigo/Geist theme).

import { useState } from "react";

type RsvpState = "pending" | "interested" | "not_going" | "booked";

const RSVP_OPTIONS: { value: RsvpState; label: string }[] = [
  { value: "pending", label: "Pending (no response)" },
  { value: "interested", label: "Interested" },
  { value: "not_going", label: "Not going" },
  { value: "booked", label: "Booked" },
];

type BroadcastResult =
  | { sent: number; suppressed: number; failed: number; reason?: never }
  | { sent: 0; suppressed: 0; failed: 0; reason: "no_recipients" };

const HEADING = "font-[family-name:var(--font-quicksand)] text-xl font-bold text-[var(--cruise-text)]";
const LABEL = "text-sm font-semibold text-[var(--cruise-text)]";
const INPUT =
  "w-full rounded-[var(--cruise-radius-itinerary)] border border-[var(--cruise-border)] bg-[var(--cruise-bg)] px-3 py-2 text-sm text-[var(--cruise-text)] placeholder:text-[var(--cruise-text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cruise-accent)]";
const BUTTON_PRIMARY =
  "rounded-[var(--cruise-radius-pill)] bg-[var(--cruise-accent)] px-5 py-2.5 font-[family-name:var(--font-quicksand)] text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60";

export function BroadcastComposerClient({ groupId }: { groupId: string }) {
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [selectedStates, setSelectedStates] = useState<Set<RsvpState>>(
    new Set(["interested", "booked"]),
  );
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<BroadcastResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggleState(state: RsvpState) {
    setSelectedStates((prev) => {
      const next = new Set(prev);
      if (next.has(state)) {
        next.delete(state);
      } else {
        next.add(state);
      }
      return next;
    });
    setResult(null);
    setError(null);
  }

  async function send() {
    setError(null);
    setResult(null);
    setSending(true);
    try {
      const res = await fetch(`/api/groups/${groupId}/broadcast`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject,
          message,
          recipient_states: Array.from(selectedStates),
        }),
      });
      const data: BroadcastResult & { error?: string } = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Error ${res.status}`);
        return;
      }
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  const canSubmit =
    !sending && subject.trim().length > 0 && message.trim().length > 0 && selectedStates.size > 0;

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className={HEADING}>Send Broadcast</h2>
        <p className="mt-1 text-sm font-medium text-[var(--cruise-text-muted)]">
          Compose and send a message to selected invitees.
        </p>
      </div>

      <div className="flex max-w-xl flex-col gap-5 rounded-[var(--cruise-radius-card)] bg-[var(--cruise-surface)] p-6 shadow-[var(--cruise-card-shadow)]">
        <div className="flex flex-col gap-1">
          <label htmlFor="broadcast-subject" className={LABEL}>Subject</label>
          <input
            id="broadcast-subject"
            value={subject}
            onChange={(e) => { setSubject(e.target.value); setResult(null); setError(null); }}
            placeholder="Trip update from your coordinator"
            maxLength={200}
            disabled={sending}
            className={INPUT}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="broadcast-message" className={LABEL}>Message</label>
          <textarea
            id="broadcast-message"
            value={message}
            onChange={(e) => { setMessage(e.target.value); setResult(null); setError(null); }}
            placeholder="Your message to the group…"
            rows={6}
            maxLength={20000}
            disabled={sending}
            className={`${INPUT} resize-none`}
          />
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold text-[var(--cruise-text)]">Send to</legend>
          {RSVP_OPTIONS.map(({ value, label }) => (
            <label key={value} className="flex cursor-pointer items-center gap-2 text-sm text-[var(--cruise-text)]">
              <input
                type="checkbox"
                checked={selectedStates.has(value)}
                onChange={() => toggleState(value)}
                disabled={sending}
                className="h-4 w-4 accent-[var(--cruise-accent)]"
              />
              {label}
            </label>
          ))}
          {selectedStates.size === 0 && (
            <p className="mt-1 text-[13px] text-[var(--cruise-coral)]">Select at least one recipient group.</p>
          )}
        </fieldset>

        <div>
          <button type="button" onClick={send} disabled={!canSubmit} className={BUTTON_PRIMARY}>
            {sending ? "Sending…" : "Send broadcast"}
          </button>
        </div>

        {error && (
          <div className="rounded-[var(--cruise-radius-itinerary)] bg-[var(--cruise-bg)] px-4 py-3 text-[13px] text-[var(--cruise-coral)]">
            {error}
          </div>
        )}

        {result && (
          <div className="flex flex-col gap-1 rounded-[var(--cruise-radius-itinerary)] bg-[var(--cruise-bg)] px-4 py-3 text-sm text-[var(--cruise-text)]">
            {result.reason === "no_recipients" ? (
              <p className="text-[var(--cruise-text-muted)]">
                No invitees match the selected RSVP states — broadcast not sent.
              </p>
            ) : (
              <p>
                <span className="font-medium text-[var(--cruise-success)]">{result.sent} sent</span>
                {result.suppressed > 0 && (
                  <span className="ml-3 text-[var(--cruise-text-muted)]">{result.suppressed} suppressed</span>
                )}
                {result.failed > 0 && (
                  <span className="ml-3 text-[var(--cruise-coral)]">{result.failed} failed</span>
                )}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
