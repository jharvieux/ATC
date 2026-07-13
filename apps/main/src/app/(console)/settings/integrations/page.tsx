"use client";

// #712 / #996 — Personal API tokens settings page.
//
// tenant_owner: create tokens acting as any active member (member picker),
//   see all tokens in the tenant with "Acting as" column, revoke any.
// other roles: see only tokens that act as them (read-only, no create/revoke).
//
// The plaintext token is shown exactly once after creation; after that
// only the name, acting member, scopes, and last-used date are visible.
//
// #1791 — the 14 useState hooks (page load, member picker, create-form,
// revoke) are grouped into 4 state objects by concern, one useState each.

import { useCallback, useEffect, useState } from "react";
import { formatDate } from "@/lib/format-date";
import { Button } from "@/components/ui/button";

interface ActingUser {
  display_name: string | null;
  email: string;
}

interface ApiToken {
  id: string;
  name: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  user_id: string;
  created_by_user_id: string;
  users: ActingUser | null;
  creators: ActingUser | null;
}

interface Member {
  id: string;
  email: string;
  display_name: string | null;
}

interface PageState {
  tokens: ApiToken[];
  isOwner: boolean;
  loadErr: string | null;
  forbidden: boolean;
}

interface MemberPickerState {
  members: Member[];
  selfId: string | null;
  selectedUserId: string;
}

interface CreateFormState {
  newName: string;
  creating: boolean;
  createErr: string | null;
  newPlaintext: string | null;
  copied: boolean;
}

interface RevokeState {
  revoking: string | null;
  revokeErr: string | null;
}

export default function IntegrationsSettingsPage(): React.JSX.Element {
  const [page, setPage] = useState<PageState>({
    tokens: [], isOwner: false, loadErr: null, forbidden: false,
  });
  const [memberPicker, setMemberPicker] = useState<MemberPickerState>({
    members: [], selfId: null, selectedUserId: "",
  });
  const [createForm, setCreateForm] = useState<CreateFormState>({
    newName: "", creating: false, createErr: null, newPlaintext: null, copied: false,
  });
  const [revokeState, setRevokeState] = useState<RevokeState>({ revoking: null, revokeErr: null });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations/tokens");
      if (res.status === 403) { setPage((p) => ({ ...p, forbidden: true })); return; }
      if (!res.ok) { setPage((p) => ({ ...p, loadErr: `Load failed (HTTP ${res.status})` })); return; }
      const d = (await res.json()) as { tokens: ApiToken[]; is_owner: boolean };
      setPage((p) => ({ ...p, tokens: d.tokens, isOwner: d.is_owner }));
    } catch (e) {
      setPage((p) => ({ ...p, loadErr: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  const loadMembers = useCallback(async () => {
    try {
      const res = await fetch("/api/tenant/users");
      if (!res.ok) return;
      const d = (await res.json()) as { members: Member[]; caller_role: string };
      setMemberPicker((m) => ({ ...m, members: d.members }));
    } catch {
      // Members are optional; failure is non-fatal.
    }
  }, []);

  const loadSelf = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me");
      if (!res.ok) return;
      const d = (await res.json()) as { user_id?: string };
      if (d.user_id) {
        setMemberPicker((m) => ({ ...m, selfId: d.user_id ?? null, selectedUserId: d.user_id ?? "" }));
      }
    } catch {
      // Best-effort.
    }
  }, []);

  useEffect(() => {
    void load();
    void loadSelf();
    void loadMembers();
  }, [load, loadSelf, loadMembers]);

  async function createToken(): Promise<void> {
    const name = createForm.newName.trim();
    if (!name) { setCreateForm((f) => ({ ...f, createErr: "Enter a token name." })); return; }
    setCreateForm((f) => ({ ...f, creating: true, createErr: null, newPlaintext: null }));
    try {
      const body: { name: string; scopes: string[]; user_id?: string } = {
        name,
        scopes: ["rag_submissions:create"],
      };
      if (memberPicker.selectedUserId && memberPicker.selectedUserId !== memberPicker.selfId) {
        body.user_id = memberPicker.selectedUserId;
      }
      const res = await fetch("/api/integrations/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = (await res.json()) as { error?: string };
        setCreateForm((f) => ({ ...f, createErr: e.error ?? `HTTP ${res.status}` }));
        return;
      }
      const d = (await res.json()) as { token: string } & ApiToken;
      setCreateForm((f) => ({ ...f, newPlaintext: d.token, newName: "" }));
      await load();
    } finally {
      setCreateForm((f) => ({ ...f, creating: false }));
    }
  }

  async function revokeToken(id: string): Promise<void> {
    setRevokeState({ revoking: id, revokeErr: null });
    try {
      const res = await fetch(`/api/integrations/tokens/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const e = (await res.json()) as { error?: string };
        setRevokeState((s) => ({ ...s, revokeErr: e.error ?? `HTTP ${res.status}` }));
        return;
      }
      await load();
    } finally {
      setRevokeState((s) => ({ ...s, revoking: null }));
    }
  }

  async function copyToken(): Promise<void> {
    if (!createForm.newPlaintext) return;
    await navigator.clipboard.writeText(createForm.newPlaintext);
    setCreateForm((f) => ({ ...f, copied: true }));
    setTimeout(() => setCreateForm((f) => ({ ...f, copied: false })), 2000);
  }

  if (page.forbidden) {
    return (
      <main className="px-6 py-10 max-w-[720px] mx-auto">
        <p className="text-sm text-muted-foreground">You do not have access to API token management.</p>
      </main>
    );
  }

  function actingLabel(tok: ApiToken): string {
    const u = tok.users;
    if (!u) return tok.user_id;
    return u.display_name ?? u.email;
  }

  function createdByLabel(tok: ApiToken): string {
    const u = tok.creators;
    if (!u) return tok.created_by_user_id;
    return u.display_name ?? u.email;
  }

  const activeTokens = page.tokens.filter((t) => !t.revoked_at);
  const revokedTokens = page.tokens.filter((t) => t.revoked_at);

  return (
    <main className="px-6 py-10 max-w-[720px] mx-auto">
      <h1 className="text-2xl font-bold mb-1">API Tokens</h1>
      <p className="text-muted-foreground text-[14px] mb-8">
        Personal access tokens let external tools (like the iOS Shortcut) submit RAG content to your workspace.
        {page.isOwner
          ? " As an owner, you can mint tokens that act as any active workspace member."
          : " Tokens shown here act on your behalf."}
      </p>

      {/* New token form — owners only */}
      {page.isOwner && (
        <section className="mb-8 border border-border rounded-lg p-5 bg-card">
          <h2 className="text-[15px] font-semibold mb-3">Create new token</h2>
          <div className="flex gap-2 items-start flex-wrap">
            <input
              type="text"
              placeholder="Token name (e.g. iOS Shortcut)"
              value={createForm.newName}
              onChange={(e) => setCreateForm((f) => ({ ...f, newName: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") void createToken(); }}
              maxLength={100}
              className="flex-1 min-w-[200px] rounded border border-border px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {memberPicker.members.length > 1 && (
              <select
                value={memberPicker.selectedUserId}
                onChange={(e) => setMemberPicker((m) => ({ ...m, selectedUserId: e.target.value }))}
                className="rounded border border-border px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {memberPicker.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name ?? m.email}{m.id === memberPicker.selfId ? " (you)" : ""}
                  </option>
                ))}
              </select>
            )}
            <Button onClick={() => void createToken()} disabled={createForm.creating || !createForm.newName.trim()}>
              {createForm.creating ? "Creating…" : "Create"}
            </Button>
          </div>
          {createForm.createErr && <p className="text-destructive text-[13px] mt-2">{createForm.createErr}</p>}

          {createForm.newPlaintext && (
            <div className="mt-4 border border-border rounded-md p-4 bg-muted">
              <p className="text-[13px] font-semibold text-foreground mb-2">
                Copy this token now — it will not be shown again.
              </p>
              <div className="flex gap-2 items-center">
                <code className="flex-1 text-[12px] font-mono break-all text-foreground bg-background border border-border rounded px-2 py-1.5">
                  {createForm.newPlaintext}
                </code>
                <Button variant="outline" onClick={() => void copyToken()}>
                  {createForm.copied ? "Copied!" : "Copy"}
                </Button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Active tokens */}
      {page.loadErr && <p className="text-destructive text-[13px] mb-4">{page.loadErr}</p>}
      {revokeState.revokeErr && <p className="text-destructive text-[13px] mb-4">{revokeState.revokeErr}</p>}

      {activeTokens.length > 0 && (
        <section className="mb-6">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground mb-2.5">
            Active tokens
          </h2>
          <div className="flex flex-col gap-0.5">
            {activeTokens.map((tok) => (
              <div
                key={tok.id}
                className="flex items-center justify-between px-3.5 py-3 border border-border rounded-lg bg-card"
              >
                <div>
                  <p className="font-semibold text-[14px] text-foreground">{tok.name}</p>
                  <p className="text-[12px] text-muted-foreground mt-0.5">
                    {page.isOwner && (
                      <>Acting as {actingLabel(tok)} &middot; Created by {createdByLabel(tok)} &middot;{" "}</>
                    )}
                    Scopes: {tok.scopes.join(", ")} &middot;{" "}
                    {tok.last_used_at
                      ? `Last used ${formatDate(tok.last_used_at)}`
                      : "Never used"}{" "}
                    &middot; Created {formatDate(tok.created_at)}
                  </p>
                </div>
                {page.isOwner && (
                  <Button
                    variant="outline"
                    onClick={() => void revokeToken(tok.id)}
                    disabled={revokeState.revoking === tok.id}
                    className="text-destructive hover:text-destructive"
                  >
                    {revokeState.revoking === tok.id ? "Revoking…" : "Revoke"}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {activeTokens.length === 0 && !page.loadErr && (
        <p className="text-[14px] text-muted-foreground mb-6">No active tokens. {page.isOwner ? "Create one above." : "No tokens are acting on your behalf."}</p>
      )}

      {/* Revoked tokens */}
      {revokedTokens.length > 0 && (
        <section>
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground mb-2.5">
            Revoked tokens
          </h2>
          <div className="flex flex-col gap-0.5">
            {revokedTokens.map((tok) => (
              <div
                key={tok.id}
                className="flex items-center justify-between px-3.5 py-3 border border-border rounded-lg bg-card opacity-60"
              >
                <div>
                  <p className="font-semibold text-[14px] text-foreground line-through">{tok.name}</p>
                  <p className="text-[12px] text-muted-foreground mt-0.5">
                    {page.isOwner && <>Acting as {actingLabel(tok)} &middot;{" "}</>}
                    Revoked {formatDate(tok.revoked_at!)} &middot; Created{" "}
                    {formatDate(tok.created_at)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
