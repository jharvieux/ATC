"use client";

// #712 / #996 — Personal API tokens settings page.
//
// tenant_owner: create tokens acting as any active member (member picker),
//   see all tokens in the tenant with "Acting as" column, revoke any.
// other roles: see only tokens that act as them (read-only, no create/revoke).
//
// The plaintext token is shown exactly once after creation; after that
// only the name, acting member, scopes, and last-used date are visible.

import { useCallback, useEffect, useState } from "react";
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

export default function IntegrationsSettingsPage(): React.JSX.Element {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  // Member picker
  const [members, setMembers] = useState<Member[]>([]);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string>("");

  // Create-token form
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [newPlaintext, setNewPlaintext] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Revoke state
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeErr, setRevokeErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations/tokens");
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) { setLoadErr(`Load failed (HTTP ${res.status})`); return; }
      const d = (await res.json()) as { tokens: ApiToken[]; is_owner: boolean };
      setTokens(d.tokens);
      setIsOwner(d.is_owner);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadMembers = useCallback(async () => {
    try {
      const res = await fetch("/api/tenant/users");
      if (!res.ok) return;
      const d = (await res.json()) as { members: Member[]; caller_role: string };
      setMembers(d.members);
      // Identify self from the /api/auth/me endpoint to pre-select in picker.
    } catch {
      // Members are optional; failure is non-fatal.
    }
  }, []);

  const loadSelf = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me");
      if (!res.ok) return;
      const d = (await res.json()) as { id?: string };
      if (d.id) {
        setSelfId(d.id);
        setSelectedUserId(d.id);
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
    const name = newName.trim();
    if (!name) { setCreateErr("Enter a token name."); return; }
    setCreating(true);
    setCreateErr(null);
    setNewPlaintext(null);
    try {
      const body: { name: string; scopes: string[]; user_id?: string } = {
        name,
        scopes: ["rag_submissions:create"],
      };
      if (selectedUserId && selectedUserId !== selfId) {
        body.user_id = selectedUserId;
      }
      const res = await fetch("/api/integrations/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = (await res.json()) as { error?: string };
        setCreateErr(e.error ?? `HTTP ${res.status}`);
        return;
      }
      const d = (await res.json()) as { token: string } & ApiToken;
      setNewPlaintext(d.token);
      setNewName("");
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function revokeToken(id: string): Promise<void> {
    setRevoking(id);
    setRevokeErr(null);
    try {
      const res = await fetch(`/api/integrations/tokens/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const e = (await res.json()) as { error?: string };
        setRevokeErr(e.error ?? `HTTP ${res.status}`);
        return;
      }
      await load();
    } finally {
      setRevoking(null);
    }
  }

  async function copyToken(): Promise<void> {
    if (!newPlaintext) return;
    await navigator.clipboard.writeText(newPlaintext);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (forbidden) {
    return (
      <main className="px-6 py-10 max-w-[720px] mx-auto">
        <p className="text-sm text-muted-foreground">API token management is available to workspace owners only.</p>
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

  const activeTokens = tokens.filter((t) => !t.revoked_at);
  const revokedTokens = tokens.filter((t) => t.revoked_at);

  return (
    <main className="px-6 py-10 max-w-[720px] mx-auto">
      <h1 className="text-2xl font-bold mb-1">API Tokens</h1>
      <p className="text-muted-foreground text-[14px] mb-8">
        Personal access tokens let external tools (like the iOS Shortcut) submit RAG content to your workspace.
        {isOwner
          ? " As an owner, you can mint tokens that act as any active workspace member."
          : " Tokens shown here act on your behalf."}
      </p>

      {/* New token form — owners only */}
      {isOwner && (
        <section className="mb-8 border border-border rounded-lg p-5 bg-card">
          <h2 className="text-[15px] font-semibold mb-3">Create new token</h2>
          <div className="flex gap-2 items-start flex-wrap">
            <input
              type="text"
              placeholder="Token name (e.g. iOS Shortcut)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void createToken(); }}
              maxLength={100}
              className="flex-1 min-w-[200px] rounded border border-border px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {members.length > 1 && (
              <select
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="rounded border border-border px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name ?? m.email}{m.id === selfId ? " (you)" : ""}
                  </option>
                ))}
              </select>
            )}
            <Button onClick={() => void createToken()} disabled={creating || !newName.trim()}>
              {creating ? "Creating…" : "Create"}
            </Button>
          </div>
          {createErr && <p className="text-destructive text-[13px] mt-2">{createErr}</p>}

          {newPlaintext && (
            <div className="mt-4 border border-border rounded-md p-4 bg-muted">
              <p className="text-[13px] font-semibold text-foreground mb-2">
                Copy this token now — it will not be shown again.
              </p>
              <div className="flex gap-2 items-center">
                <code className="flex-1 text-[12px] font-mono break-all text-foreground bg-background border border-border rounded px-2 py-1.5">
                  {newPlaintext}
                </code>
                <Button variant="outline" onClick={() => void copyToken()}>
                  {copied ? "Copied!" : "Copy"}
                </Button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Active tokens */}
      {loadErr && <p className="text-destructive text-[13px] mb-4">{loadErr}</p>}
      {revokeErr && <p className="text-destructive text-[13px] mb-4">{revokeErr}</p>}

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
                    {isOwner && (
                      <>Acting as {actingLabel(tok)} &middot; Created by {createdByLabel(tok)} &middot;{" "}</>
                    )}
                    Scopes: {tok.scopes.join(", ")} &middot;{" "}
                    {tok.last_used_at
                      ? `Last used ${new Date(tok.last_used_at).toLocaleDateString()}`
                      : "Never used"}{" "}
                    &middot; Created {new Date(tok.created_at).toLocaleDateString()}
                  </p>
                </div>
                {isOwner && (
                  <Button
                    variant="outline"
                    onClick={() => void revokeToken(tok.id)}
                    disabled={revoking === tok.id}
                    className="text-destructive hover:text-destructive"
                  >
                    {revoking === tok.id ? "Revoking…" : "Revoke"}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {activeTokens.length === 0 && !loadErr && (
        <p className="text-[14px] text-muted-foreground mb-6">No active tokens. {isOwner ? "Create one above." : "No tokens are acting on your behalf."}</p>
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
                    {isOwner && <>Acting as {actingLabel(tok)} &middot;{" "}</>}
                    Revoked {new Date(tok.revoked_at!).toLocaleDateString()} &middot; Created{" "}
                    {new Date(tok.created_at).toLocaleDateString()}
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
