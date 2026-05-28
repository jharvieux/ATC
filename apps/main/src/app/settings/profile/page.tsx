"use client";

// §25.3 right-to-correct — basic profile fields editor.
// Email is read-only here (OAuth identity). To change email the customer
// re-authenticates with the OAuth provider that holds the new address.

import { useEffect, useState } from "react";

type Profile = {
  email: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  auth_provider: string | null;
};

export default function ProfilePage(): JSX.Element {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [draft, setDraft] = useState<Partial<Profile>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void load(); }, []);

  async function load(): Promise<void> {
    setError(null);
    try {
      const res = await fetch("/api/user/profile");
      if (!res.ok) throw new Error(`load failed: ${res.status}`);
      const body = (await res.json()) as Profile;
      setProfile(body);
      setDraft({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function setField<K extends "first_name" | "last_name" | "display_name">(key: K, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function isDirty(): boolean {
    if (!profile) return false;
    return (["first_name", "last_name", "display_name"] as const).some((k) => k in draft && (draft[k] ?? "") !== (profile[k] ?? ""));
  }

  async function save(): Promise<void> {
    if (!profile) return;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      // Send only fields the customer actually changed. Treat empty string as
      // null (clearing a field) to match the schema's nullable contract.
      const payload: Record<string, string | null> = {};
      for (const k of ["first_name", "last_name", "display_name"] as const) {
        if (k in draft) {
          const v = (draft[k] ?? "").trim();
          payload[k] = v === "" ? null : v;
        }
      }
      const res = await fetch("/api/user/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? "save failed");
      setMsg("Saved.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!profile) return <main style={{ padding: 24 }}>Loading…</main>;

  return (
    <main style={{ padding: 24, maxWidth: 680, margin: "0 auto" }}>
      <h1>Profile</h1>
      <p style={{ color: "#555" }}>
        Names and display preferences. To change your email, sign in again with
        the account that holds the new address.
      </p>

      {error && <div style={{ background: "#fee2e2", padding: 12, borderRadius: 6, marginTop: 12 }}>{error}</div>}
      {msg && <div style={{ background: "#dcfce7", padding: 12, borderRadius: 6, marginTop: 12 }}>{msg}</div>}

      <section style={{ marginTop: 16 }}>
        <Field label="Email" value={profile.email} readOnly />
        <Field
          label="Sign-in provider"
          value={profile.auth_provider ?? "(unknown)"}
          readOnly
        />
        <Field
          label="First name"
          value={(draft.first_name ?? profile.first_name) ?? ""}
          onChange={(v) => setField("first_name", v)}
        />
        <Field
          label="Last name"
          value={(draft.last_name ?? profile.last_name) ?? ""}
          onChange={(v) => setField("last_name", v)}
        />
        <Field
          label="Display name"
          value={(draft.display_name ?? profile.display_name) ?? ""}
          onChange={(v) => setField("display_name", v)}
          hint="What we'll call you in chat (defaults to your first name)."
        />

        <button
          onClick={save}
          disabled={busy || !isDirty()}
          style={{
            marginTop: 16,
            padding: "8px 14px",
            fontSize: 14,
            color: "white",
            background: isDirty() && !busy ? "#2563eb" : "#9ca3af",
            border: 0,
            borderRadius: 4,
            cursor: isDirty() && !busy ? "pointer" : "default",
          }}
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
      </section>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  readOnly,
  hint,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  hint?: string;
}): JSX.Element {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: "block", fontSize: 13, color: "#555", marginBottom: 4 }}>{label}</label>
      <input
        type="text"
        value={value}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        readOnly={readOnly}
        style={{
          width: "100%",
          padding: "8px 10px",
          fontSize: 14,
          border: "1px solid #d1d5db",
          borderRadius: 4,
          background: readOnly ? "#f3f4f6" : "white",
          color: readOnly ? "#6b7280" : "#111827",
        }}
      />
      {hint && <p style={{ margin: "4px 0 0 0", fontSize: 12, color: "#6b7280" }}>{hint}</p>}
    </div>
  );
}
