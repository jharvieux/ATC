"use client";

// §18.6 — Coordinator broadcast composer. Subject + message + RSVP-state
// recipient checkboxes → POST /api/groups/[id]/broadcast.
// Default states: interested + booked (mirrors the backend default).

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

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
    <section>
      <h2 className="text-[18px] font-bold mb-4">Send Broadcast</h2>
      <p className="text-muted-foreground mb-6 text-[14px]">
        Compose and send a message to selected invitees.
      </p>

      <div className="flex flex-col gap-5 max-w-xl">
        <div className="flex flex-col gap-1">
          <Label htmlFor="broadcast-subject">Subject</Label>
          <Input
            id="broadcast-subject"
            value={subject}
            onChange={(e) => { setSubject(e.target.value); setResult(null); setError(null); }}
            placeholder="Trip update from your coordinator"
            maxLength={200}
            disabled={sending}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="broadcast-message">Message</Label>
          <Textarea
            id="broadcast-message"
            value={message}
            onChange={(e) => { setMessage(e.target.value); setResult(null); setError(null); }}
            placeholder="Your message to the group…"
            rows={6}
            maxLength={20000}
            disabled={sending}
          />
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-[14px] font-medium mb-1">Send to</legend>
          {RSVP_OPTIONS.map(({ value, label }) => (
            <label key={value} className="flex items-center gap-2 text-[14px] cursor-pointer">
              <input
                type="checkbox"
                checked={selectedStates.has(value)}
                onChange={() => toggleState(value)}
                disabled={sending}
                className="h-4 w-4"
              />
              {label}
            </label>
          ))}
          {selectedStates.size === 0 && (
            <p className="text-[13px] text-destructive mt-1">Select at least one recipient group.</p>
          )}
        </fieldset>

        <div>
          <Button
            onClick={send}
            disabled={!canSubmit}
          >
            {sending ? "Sending…" : "Send broadcast"}
          </Button>
        </div>

        {error && (
          <div className="rounded-md bg-destructive/10 text-destructive text-[13px] px-4 py-3">
            {error}
          </div>
        )}

        {result && (
          <div className="rounded-md bg-muted px-4 py-3 text-[14px] flex flex-col gap-1">
            {result.reason === "no_recipients" ? (
              <p className="text-muted-foreground">
                No invitees match the selected RSVP states — broadcast not sent.
              </p>
            ) : (
              <>
                <p>
                  <span className="font-medium text-emerald-600">{result.sent} sent</span>
                  {result.suppressed > 0 && (
                    <span className="ml-3 text-muted-foreground">{result.suppressed} suppressed</span>
                  )}
                  {result.failed > 0 && (
                    <span className="ml-3 text-destructive">{result.failed} failed</span>
                  )}
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
