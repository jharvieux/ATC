"use client";

// §18 / BP19 — Coordinator invitees tab.
// Fetches the invitation roster from /api/groups/:id/invitations and
// invitation_counts from /api/groups/:id. Shows RSVP-state summary chips
// and a per-invitee table with a revoke (remove) action.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

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
  pending: "bg-gray-100 text-gray-700",
  interested: "bg-amber-100 text-amber-700",
  not_going: "bg-red-100 text-red-600",
  booked: "bg-emerald-100 text-emerald-700",
};

const RSVP_LABEL: Record<RsvpState, string> = {
  pending: "Pending",
  interested: "Interested",
  not_going: "Not going",
  booked: "Booked",
};

export function InviteesTabClient({ groupId }: { groupId: string }) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [counts, setCounts] = useState<Partial<Record<RsvpState, number>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

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

  if (loading) {
    return (
      <section>
        <h2 className="text-[18px] font-bold mb-4">Invitees</h2>
        <p className="text-muted-foreground text-[14px]">Loading invitees…</p>
      </section>
    );
  }

  const activeInvites = invitations.filter((i) => !i.token_revoked_at);
  const revokedInvites = invitations.filter((i) => i.token_revoked_at);

  const countChips = (["booked", "interested", "pending", "not_going"] as RsvpState[]).filter(
    (s) => (counts[s] ?? 0) > 0,
  );

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[18px] font-bold">Invitees</h2>
        <Button variant="outline" onClick={load} disabled={loading}>
          Refresh
        </Button>
      </div>

      {countChips.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-5">
          {countChips.map((state) => (
            <span
              key={state}
              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[12px] font-medium ${RSVP_CHIP_STYLES[state]}`}
            >
              {counts[state]} {RSVP_LABEL[state]}
            </span>
          ))}
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-md bg-destructive/10 text-destructive text-[13px] px-4 py-3">
          {error}
        </div>
      )}

      {revokeError && (
        <div className="mb-4 rounded-md bg-destructive/10 text-destructive text-[13px] px-4 py-3">
          {revokeError}
        </div>
      )}

      {invitations.length === 0 ? (
        <p className="text-muted-foreground text-[14px]">No invitees yet.</p>
      ) : (
        <>
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr className="border-b-2 border-border">
                <th className="text-left px-3 py-2 font-semibold">Name</th>
                <th className="text-left px-3 py-2 font-semibold">Email</th>
                <th className="text-left px-3 py-2 font-semibold">RSVP</th>
                <th className="text-left px-3 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {activeInvites.map((inv) => (
                <tr key={inv.id} className="border-b border-border hover:bg-muted/40">
                  <td className="px-3 py-2">{inv.invitee_name ?? "—"}</td>
                  <td className="px-3 py-2">{inv.invitee_email}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[12px] font-medium ${RSVP_CHIP_STYLES[inv.rsvp_state]}`}
                    >
                      {RSVP_LABEL[inv.rsvp_state]}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      variant="outline"
                      onClick={() => revoke(inv.id)}
                      disabled={revoking === inv.id}
                      className="h-7 text-[12px] text-destructive border-destructive/40 hover:bg-destructive/10"
                    >
                      {revoking === inv.id ? "Removing…" : "Remove"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {revokedInvites.length > 0 && (
            <details className="mt-4">
              <summary className="text-[13px] text-muted-foreground cursor-pointer select-none">
                {revokedInvites.length} removed
              </summary>
              <table className="w-full border-collapse text-[13px] mt-2 opacity-60">
                <tbody>
                  {revokedInvites.map((inv) => (
                    <tr key={inv.id} className="border-b border-border">
                      <td className="px-3 py-2">{inv.invitee_name ?? "—"}</td>
                      <td className="px-3 py-2">{inv.invitee_email}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {inv.token_revoked_reason ?? "removed"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </>
      )}
    </section>
  );
}
