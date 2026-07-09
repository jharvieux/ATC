"use client";

// §26 — Platform-admin management UI.
//
// Superadmins add/change/remove platform admins; every other admin sees the
// list read-only. Self-row is never editable/removable (the API also enforces
// this — the UI just hides the controls so it isn't a click-then-409).

import { useEffect, useState } from "react";
import { formatDate } from "@/lib/format-date";
import { adminFetch } from "@/lib/admin-fetch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PLATFORM_ADMIN_ROLES,
  PLATFORM_ADMIN_ROLE_LABELS,
  PLATFORM_ADMIN_ROLE_DESCRIPTIONS,
  type PlatformAdminRole,
} from "@/lib/auth/platform-admin-roles";

interface Admin {
  auth_user_id: string;
  role: PlatformAdminRole;
  email: string | null;
  notes: string | null;
  created_at: string;
  created_by_auth_user_id: string | null;
}

interface ListResponse {
  admins: Admin[];
  caller_id: string;
  caller_role: string;
  can_manage: boolean;
}

export default function AdminAdminsPage(): JSX.Element {
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [callerId, setCallerId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<PlatformAdminRole>("reviewer");
  const [notes, setNotes] = useState("");

  async function refresh(): Promise<void> {
    setError(null);
    try {
      const res = await adminFetch("/api/admin/admins");
      if (!res.ok) throw new Error(`Load failed: HTTP ${res.status}`);
      const body = (await res.json()) as ListResponse;
      setAdmins(body.admins ?? []);
      setCanManage(body.can_manage);
      setCallerId(body.caller_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function addAdmin(): Promise<void> {
    if (!email.trim()) {
      setError("Email is required.");
      return;
    }
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await adminFetch("/api/admin/admins", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), role, notes: notes.trim() || undefined }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; detail?: string };
      if (!res.ok) throw new Error(body.detail ?? body.error ?? `HTTP ${res.status}`);
      setMsg(`Added ${email.trim()} as ${PLATFORM_ADMIN_ROLE_LABELS[role]}.`);
      setEmail("");
      setNotes("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(id: string, newRole: PlatformAdminRole): Promise<void> {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await adminFetch(`/api/admin/admins/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ role: newRole }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; detail?: string };
      if (!res.ok) throw new Error(body.detail ?? body.error ?? `HTTP ${res.status}`);
      setMsg("Role updated.");
      setAdmins((prev) => prev.map((a) => (a.auth_user_id === id ? { ...a, role: newRole } : a)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function removeAdmin(id: string, label: string): Promise<void> {
    if (!confirm(`Remove ${label} from platform admins?`)) return;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await adminFetch(`/api/admin/admins/${id}`, { method: "DELETE" });
      const body = (await res.json()) as { ok?: boolean; error?: string; detail?: string };
      if (!res.ok) throw new Error(body.detail ?? body.error ?? `HTTP ${res.status}`);
      setMsg("Admin removed.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="px-6 py-6 max-w-[860px] mx-auto">
      <h1>Platform admins</h1>
      <p className="text-muted-foreground">
        People with access to this admin console.{" "}
        {canManage
          ? "As a superadmin you can add, re-role, or remove admins."
          : "Only superadmins can add, re-role, or remove admins — this list is read-only for your role."}
      </p>

      {error && (
        <div role="alert" className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 px-3.5 py-2.5 rounded-md mt-4">
          {error}
        </div>
      )}
      {msg && (
        <div role="status" className="bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 text-green-800 dark:text-green-300 px-3.5 py-2.5 rounded-md mt-4">
          {msg}
        </div>
      )}

      {canManage && (
        <section className="mt-6 p-4 border border-border rounded-lg">
          <h2 className="mt-0 text-lg font-semibold">Add admin</h2>
          <p className="text-[13px] text-muted-foreground mt-0.5 mb-3">
            Enter the email of someone who has already signed in at least once. They&apos;ll get
            admin access immediately at the chosen role.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex-1 text-sm">
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="person@example.com"
                disabled={busy}
                className="block w-full px-2 py-1.5 border border-border rounded mt-1 text-sm bg-background"
              />
            </label>
            <label className="text-sm">
              Role
              <div className="mt-1">
                <Select value={role} onValueChange={(v) => setRole(v as PlatformAdminRole)} disabled={busy}>
                  <SelectTrigger className="w-[150px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PLATFORM_ADMIN_ROLES.map((r) => (
                      <SelectItem key={r} value={r}>{PLATFORM_ADMIN_ROLE_LABELS[r]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </label>
            <button
              type="button"
              onClick={() => void addAdmin()}
              disabled={busy || loading}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-semibold disabled:opacity-50 h-9"
            >
              {busy ? "Saving…" : "Add"}
            </button>
          </div>
          <label className="block text-sm mt-3">
            Notes (optional, recorded in the audit log)
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={busy}
              className="block w-full px-2 py-1.5 border border-border rounded mt-1 text-sm bg-background"
            />
          </label>
        </section>
      )}

      <section className="mt-6">
        <h2 className="text-lg font-semibold mb-2">Current admins</h2>
        {loading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : admins.length === 0 ? (
          <p className="text-muted-foreground">No platform admins.</p>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-muted text-left">
                <tr>
                  {["Email", "Role", "Added", "Notes", ""].map((h) => (
                    <th key={h} className="px-4 py-2.5 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {admins.map((a) => {
                  const isSelf = a.auth_user_id === callerId;
                  const editable = canManage && !isSelf;
                  const label = a.email ?? a.auth_user_id;
                  return (
                    <tr key={a.auth_user_id} className="border-t border-muted">
                      <td className="px-4 py-2.5">
                        {a.email ?? <span className="font-mono text-xs">{a.auth_user_id}</span>}
                        {isSelf && <span className="text-muted-foreground"> (you)</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        {editable ? (
                          <Select
                            value={a.role}
                            onValueChange={(v) => void changeRole(a.auth_user_id, v as PlatformAdminRole)}
                            disabled={busy}
                          >
                            <SelectTrigger className="h-8 w-[140px] text-xs" title={PLATFORM_ADMIN_ROLE_DESCRIPTIONS[a.role]}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {PLATFORM_ADMIN_ROLES.map((r) => (
                                <SelectItem key={r} value={r}>{PLATFORM_ADMIN_ROLE_LABELS[r]}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span title={PLATFORM_ADMIN_ROLE_DESCRIPTIONS[a.role]}>{PLATFORM_ADMIN_ROLE_LABELS[a.role]}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {formatDate(a.created_at)}
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{a.notes ?? "—"}</td>
                      <td className="px-4 py-2.5 text-right">
                        {editable && (
                          <button
                            type="button"
                            onClick={() => void removeAdmin(a.auth_user_id, label)}
                            disabled={busy}
                            className="px-3 py-1 border border-border rounded text-xs disabled:opacity-50 hover:bg-accent"
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-6 text-[13px] text-muted-foreground">
        <h3 className="text-[14px] text-foreground font-semibold mb-2">Role meanings</h3>
        <ul className="pl-5 space-y-1">
          {PLATFORM_ADMIN_ROLES.map((r) => (
            <li key={r}>
              <strong>{PLATFORM_ADMIN_ROLE_LABELS[r]}:</strong> {PLATFORM_ADMIN_ROLE_DESCRIPTIONS[r]}
            </li>
          ))}
        </ul>
        <p className="mt-2 italic">
          Note: today every admin role has full console access; only the superadmin-only actions
          (managing admins) are role-gated. Finer per-role gating is a future enhancement.
        </p>
      </section>
    </main>
  );
}
