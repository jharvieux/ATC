"use client";

// §18 / BP19 — Coordinator invitees tab.
// Restyled to the group-landing "Bright & Vacation-y" cruise identity
// (specs/design_handoff_group_landing/) — raw elements + --cruise-* tokens
// instead of shadcn Button (which hardcodes the app-wide indigo/Geist theme).

import { useCallback, useEffect, useState, type FormEvent } from "react";

type RsvpState = "pending" | "interested" | "not_going" | "booked";

interface Invitation {
  id: string;
  invitee_email: string;
  invitee_name: string | null;
  rsvp_state: RsvpState;
  token_revoked_at: string | null;
  token_revoked_reason: string | null;
  last_email_sent_at: string | null;
}

const RSVP_CHIP_STYLES: Record<RsvpState, string> = {
  pending: "border-[var(--cruise-border)] text-[var(--cruise-text-muted)]",
  interested: "border-[#e8a017] text-[#e8a017]",
  not_going: "border-[var(--cruise-coral)] text-[var(--cruise-coral)]",
  booked: "border-[var(--cruise-success)] text-[var(--cruise-success)]",
};

const RSVP_LABEL: Record<RsvpState, string> = {
  pending: "Pending",
  interested: "Interested",
  not_going: "Not going",
  booked: "Booked",
};

const CARD = "rounded-[var(--cruise-radius-card)] bg-[var(--cruise-surface)] p-6 shadow-[var(--cruise-card-shadow)]";
const HEADING = "font-[family-name:var(--font-quicksand)] text-xl font-bold text-[var(--cruise-text)]";
const INPUT =
  "h-9 rounded-[var(--cruise-radius-itinerary)] border border-[var(--cruise-border)] bg-[var(--cruise-bg)] px-3 text-sm text-[var(--cruise-text)] placeholder:text-[var(--cruise-text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cruise-accent)]";
const BUTTON_PRIMARY =
  "rounded-[var(--cruise-radius-pill)] bg-[var(--cruise-accent)] px-4 h-9 font-[family-name:var(--font-quicksand)] text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60";
const BUTTON_OUTLINE =
  "rounded-[var(--cruise-radius-pill)] border border-[var(--cruise-border)] bg-transparent px-4 py-2 font-[family-name:var(--font-quicksand)] text-sm font-bold text-[var(--cruise-text)] transition-colors hover:bg-[var(--cruise-bg)] disabled:opacity-60";
const BUTTON_DANGER =
  "rounded-[var(--cruise-radius-pill)] border border-[var(--cruise-coral)] bg-transparent px-3 py-1 text-xs font-semibold text-[var(--cruise-coral)] transition-opacity hover:opacity-80 disabled:opacity-60";

export function InviteesTabClient({ groupId }: { groupId: string }) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [counts, setCounts] = useState<Partial<Record<RsvpState, number>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [personalNote, setPersonalNote] = useState("");
  const [visibilityChoice, setVisibilityChoice] = useState("no_opinion");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [invRes, grpRes] = await Promise.all([
        fetch(`/api/groups/${groupId}/invitations`),
        fetch(`/api/groups/${groupId}`),
      ]);
      if (!invRes.ok) {
        setError(`Failed to load invitees (${invRes.status})`);
        return;
      }
      const invData: { invitations: Invitation[] } = await invRes.json();
      setInvitations(invData.invitations ?? []);

      if (grpRes.ok) {
        const grpData: { invitation_counts: Partial<Record<RsvpState, number>> } = await grpRes.json();
        setCounts(grpData.invitation_counts ?? {});
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => { void load(); }, [load]);

  async function revoke(invitationId: string) {
    setRevoking(invitationId);
    setRevokeError(null);
    try {
      const res = await fetch(`/api/groups/${groupId}/invitations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "revoke", invitation_id: invitationId }),
      });
      if (!res.ok) {
        const d: { error?: string } = await res.json();
        setRevokeError(d.error ?? `Error ${res.status}`);
        return;
      }
      await load();
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : "Revoke failed");
    } finally {
      setRevoking(null);
    }
  }

  async function inviteSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setInviting(true);
    setInviteError(null);
    try {
      const res = await fetch(`/api/groups/${groupId}/invitations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "invite",
          invitee_email: inviteEmail,
          invitee_name: inviteName || undefined,
          personal_note: personalNote || undefined,
          visibility_choice: visibilityChoice,
        }),
      });
      if (!res.ok) {
        const d: { error?: string } = await res.json();
        setInviteError(d.error ?? `Error ${res.status}`);
        return;
      }
      setInviteEmail("");
      setInviteName("");
      setPersonalNote("");
      setVisibilityChoice("no_opinion");
      await load();
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Invite failed");
    } finally {
      setInviting(false);
    }
  }

  if (loading) {
    return (
      <section className="flex flex-col gap-4">
        <h2 className={HEADING}>Invitees</h2>
        <p className="text-sm font-medium text-[var(--cruise-text-muted)]">Loading invitees…</p>
      </section>
    );
  }

  const activeInvites = invitations.filter((i) => !i.token_revoked_at);
  const revokedInvites = invitations.filter((i) => i.token_revoked_at);

  const countChips = (["booked", "interested", "pending", "not_going"] as RsvpState[]).filter(
    (s) => (counts[s] ?? 0) > 0,
  );

  return (
    <section className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h2 className={HEADING}>Invitees</h2>
        <button type="button" className={BUTTON_OUTLINE} onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>

      <form onSubmit={inviteSubmit} className={`${CARD} flex flex-col gap-3`}>
        <p className="text-[13px] font-semibold text-[var(--cruise-text)]">Add Invitee</p>
        <div className="flex gap-3">
          <input
            type="email"
            required
            placeholder="Email address"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            className={`${INPUT} flex-1`}
          />
          <input
            type="text"
            placeholder="Name (optional)"
            value={inviteName}
            onChange={(e) => setInviteName(e.target.value)}
            className={`${INPUT} flex-1`}
          />
        </div>
        <textarea
          placeholder="Personal note (optional)"
          value={personalNote}
          onChange={(e) => setPersonalNote(e.target.value)}
          rows={2}
          className={`${INPUT} h-auto w-full resize-none py-2`}
        />
        <div className="flex items-center gap-3">
          <select
            value={visibilityChoice}
            onChange={(e) => setVisibilityChoice(e.target.value)}
            className={INPUT}
          >
            <option value="no_opinion">No preference</option>
            <option value="be_anonymous">Keep me anonymous</option>
            <option value="show_me_anyway">Show coordinator info</option>
          </select>
          <button type="submit" disabled={inviting} className={BUTTON_PRIMARY}>
            {inviting ? "Sending…" : "Send Invite"}
          </button>
        </div>
        {inviteError && (
          <p className="text-[13px] text-[var(--cruise-coral)]">{inviteError}</p>
        )}
      </form>

      {countChips.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {countChips.map((state) => (
            <span
              key={state}
              className={`inline-flex items-center rounded-[var(--cruise-radius-pill)] border px-2.5 py-0.5 text-[12px] font-medium ${RSVP_CHIP_STYLES[state]}`}
            >
              {counts[state]} {RSVP_LABEL[state]}
            </span>
          ))}
        </div>
      )}

      {error && (
        <div className="rounded-[var(--cruise-radius-itinerary)] bg-[var(--cruise-surface)] px-4 py-3 text-[13px] text-[var(--cruise-coral)] shadow-[var(--cruise-card-shadow)]">
          {error}
        </div>
      )}

      {revokeError && (
        <div className="rounded-[var(--cruise-radius-itinerary)] bg-[var(--cruise-surface)] px-4 py-3 text-[13px] text-[var(--cruise-coral)] shadow-[var(--cruise-card-shadow)]">
          {revokeError}
        </div>
      )}

      {invitations.length === 0 ? (
        <p className="text-sm font-medium text-[var(--cruise-text-muted)]">No invitees yet.</p>
      ) : (
        <div className={CARD}>
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr className="border-b-2 border-[var(--cruise-border)]">
                <th className="px-3 py-2 text-left font-semibold text-[var(--cruise-text)]">Name</th>
                <th className="px-3 py-2 text-left font-semibold text-[var(--cruise-text)]">Email</th>
                <th className="px-3 py-2 text-left font-semibold text-[var(--cruise-text)]">RSVP</th>
                <th className="px-3 py-2 text-left font-semibold text-[var(--cruise-text)]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {activeInvites.map((inv) => (
                <tr key={inv.id} className="border-b border-[var(--cruise-border)]">
                  <td className="px-3 py-2 text-[var(--cruise-text)]">{inv.invitee_name ?? "—"}</td>
                  <td className="px-3 py-2 text-[var(--cruise-text)]">{inv.invitee_email}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center rounded-[var(--cruise-radius-pill)] border px-2 py-0.5 text-[12px] font-medium ${RSVP_CHIP_STYLES[inv.rsvp_state]}`}
                    >
                      {RSVP_LABEL[inv.rsvp_state]}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => revoke(inv.id)}
                      disabled={revoking === inv.id}
                      className={BUTTON_DANGER}
                    >
                      {revoking === inv.id ? "Removing…" : "Remove"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {revokedInvites.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer select-none text-[13px] text-[var(--cruise-text-muted)]">
                {revokedInvites.length} removed
              </summary>
              <table className="mt-2 w-full border-collapse text-[13px] opacity-60">
                <tbody>
                  {revokedInvites.map((inv) => (
                    <tr key={inv.id} className="border-b border-[var(--cruise-border)]">
                      <td className="px-3 py-2 text-[var(--cruise-text)]">{inv.invitee_name ?? "—"}</td>
                      <td className="px-3 py-2 text-[var(--cruise-text)]">{inv.invitee_email}</td>
                      <td className="px-3 py-2 text-[var(--cruise-text-muted)]">
                        {inv.token_revoked_reason ?? "removed"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
