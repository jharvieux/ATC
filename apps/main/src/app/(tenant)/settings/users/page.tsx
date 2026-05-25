"use client";

// §26.2 — Tenant team management page.
//
// Lists all active members of the current tenant. Tenant owners get an
// inline role-selection dropdown for each member; agents and viewers see
// the list read-only.

import { useEffect, useState } from "react";

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState<boolean | null>(null); // null = unknown

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
      const data = (await res.json()) as { members: Member[] };
      setMembers(data.members ?? []);
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
        if (res.status === 403) {
          setCanEdit(false);
          throw new Error(
            body.detail ??
              "You don't have permission to change roles. Only owners can.",
          );
        }
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

  // Try to detect whether the current user can edit by probing the role
  // endpoint with a no-op (we don't actually know our own role from the
  // members list — the page is rendered before we know which row is "me").
  // For now, attempt an edit and react to 403. The dropdown is visible
  // optimistically; clicking it surfaces the 403 if the current user is
  // not an owner.
  const showRoleSelectors = canEdit !== false;

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: 960 }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Team members</h1>
      <p style={{ color: "#6b7280", marginBottom: 24 }}>
        Manage the people in your account. Only owners can change roles.
      </p>

      {error && (
        <div
          role="alert"
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            padding: "10px 14px",
            borderRadius: 6,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}
      {statusMsg && (
        <div
          role="status"
          style={{
            background: "#ecfdf5",
            border: "1px solid #a7f3d0",
            color: "#065f46",
            padding: "10px 14px",
            borderRadius: 6,
            marginBottom: 16,
          }}
        >
          {statusMsg}
        </div>
      )}

      {loading && <div style={{ color: "#6b7280" }}>Loading…</div>}

      {!loading && (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead style={{ background: "#f9fafb", textAlign: "left" }}>
              <tr>
                <th style={{ padding: "12px 16px", fontWeight: 600 }}>Name</th>
                <th style={{ padding: "12px 16px", fontWeight: 600 }}>Email</th>
                <th style={{ padding: "12px 16px", fontWeight: 600 }}>Role</th>
                <th style={{ padding: "12px 16px", fontWeight: 600 }}>Last sign-in</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const name =
                  m.display_name ??
                  [m.first_name, m.last_name].filter(Boolean).join(" ") ??
                  m.email;
                return (
                  <tr key={m.id} style={{ borderTop: "1px solid #f3f4f6" }}>
                    <td style={{ padding: "12px 16px" }}>{name}</td>
                    <td style={{ padding: "12px 16px", color: "#6b7280" }}>{m.email}</td>
                    <td style={{ padding: "12px 16px" }}>
                      {showRoleSelectors ? (
                        <select
                          value={m.role}
                          onChange={(e) => void changeRole(m.id, e.target.value as Role)}
                          disabled={busyId === m.id}
                          style={{
                            padding: "6px 8px",
                            borderRadius: 4,
                            border: "1px solid #d1d5db",
                          }}
                          aria-label={`Role for ${name}`}
                          title={ROLE_DESCRIPTIONS[m.role]}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span>{ROLE_LABELS[m.role]}</span>
                      )}
                    </td>
                    <td style={{ padding: "12px 16px", color: "#6b7280" }}>
                      {m.last_signed_in_at
                        ? new Date(m.last_signed_in_at).toLocaleString()
                        : "—"}
                    </td>
                  </tr>
                );
              })}
              {members.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    style={{ padding: "24px 16px", textAlign: "center", color: "#9ca3af" }}
                  >
                    No active members.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <section style={{ marginTop: 24, fontSize: 13, color: "#6b7280" }}>
        <h3 style={{ fontSize: 14, color: "#374151" }}>Role meanings</h3>
        <ul style={{ paddingLeft: 20, marginTop: 8 }}>
          {ROLES.map((r) => (
            <li key={r} style={{ marginBottom: 4 }}>
              <strong>{ROLE_LABELS[r]}:</strong> {ROLE_DESCRIPTIONS[r]}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
