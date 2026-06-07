"use client";

// §26.2 — Tenant team management page.
//
// Lists all active members of the current tenant. Tenant owners get an inline
// role-selection dropdown per member; agents and viewers see roles read-only.
// The caller's role comes from the list response, so non-owners never see a
// dropdown that 403s on click.

import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Role = "tenant_owner" | "agent" | "viewer";

interface Member {
  id: string;
  auth_user_id: string;
  email: string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  role: Role;
  status: string;
  last_signed_in_at: string | null;
  created_at: string;
}

const ROLE_LABELS: Record<Role, string> = {
  tenant_owner: "Owner",
  agent: "Agent",
  viewer: "Viewer",
};

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  tenant_owner: "Full access including tenant settings, team management, and forum moderation.",
  agent: "Day-to-day operations — bookings, quotes, contacts, tasks. Cannot change tenant settings.",
  viewer: "Read-only across all resources.",
};

const ROLES: Role[] = ["tenant_owner", "agent", "viewer"];

export default function TeamMembersPage(): JSX.Element {
  const [members, setMembers] = useState<Member[]>([]);
  const [callerRole, setCallerRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/tenant/users");
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { members: Member[]; caller_role: Role };
      setMembers(data.members ?? []);
      setCallerRole(data.caller_role ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function changeRole(id: string, newRole: Role): Promise<void> {
    setBusyId(id);
    setError(null);
    setStatusMsg(null);
    try {
      const res = await fetch(`/api/tenant/users/${id}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; detail?: string };
      if (!res.ok) {
        throw new Error(body.detail ?? body.error ?? `HTTP ${res.status}`);
      }
      setStatusMsg(`Updated role to ${ROLE_LABELS[newRole]}.`);
      setMembers((prev) =>
        prev.map((m) => (m.id === id ? { ...m, role: newRole } : m)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  // Only owners can change roles (team_members:update_role). Derived from the
  // caller's role in the list response — no optimistic dropdown + 403 probe.
  const canEdit = callerRole === "tenant_owner";

  return (
    <main className="p-8 max-w-[960px]">
      <h1 className="text-2xl font-semibold mb-2">Team members</h1>
      <p className="text-muted-foreground mb-6">
        Manage the people in your account. Only owners can change roles.
      </p>

      {error && (
        <div
          role="alert"
          className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 px-3.5 py-2.5 rounded-md mb-4"
        >
          {error}
        </div>
      )}
      {statusMsg && (
        <div
          role="status"
          className="bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 text-green-800 dark:text-green-300 px-3.5 py-2.5 rounded-md mb-4"
        >
          {statusMsg}
        </div>
      )}

      {loading && <div className="text-muted-foreground">Loading…</div>}

      {!loading && (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full border-collapse">
            <thead className="bg-muted text-left">
              <tr>
                {["Name", "Email", "Role", "Last sign-in"].map((h) => (
                  <th key={h} className="px-4 py-3 font-semibold text-sm">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const name =
                  m.display_name ??
                  [m.first_name, m.last_name].filter(Boolean).join(" ") ??
                  m.email;
                return (
                  <tr key={m.id} className="border-t border-muted">
                    <td className="px-4 py-3 text-sm">{name}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{m.email}</td>
                    <td className="px-4 py-3 text-sm">
                      {canEdit ? (
                        <Select
                          value={m.role}
                          onValueChange={(v) => void changeRole(m.id, v as Role)}
                          disabled={busyId === m.id}
                        >
                          <SelectTrigger className="h-8 w-[130px] text-xs" aria-label={`Role for ${name}`} title={ROLE_DESCRIPTIONS[m.role]}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ROLES.map((r) => (
                              <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <span title={ROLE_DESCRIPTIONS[m.role]}>{ROLE_LABELS[m.role]}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {m.last_signed_in_at
                        ? new Date(m.last_signed_in_at).toLocaleString()
                        : "—"}
                    </td>
                  </tr>
                );
              })}
              {members.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground text-sm">
                    No active members.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <section className="mt-6 text-[13px] text-muted-foreground">
        <h3 className="text-[14px] text-foreground font-semibold mb-2">Role meanings</h3>
        <ul className="pl-5 mt-2 space-y-1">
          {ROLES.map((r) => (
            <li key={r}>
              <strong>{ROLE_LABELS[r]}:</strong> {ROLE_DESCRIPTIONS[r]}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
