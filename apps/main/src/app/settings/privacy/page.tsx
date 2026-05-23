"use client";

// §25.7 — Granular consent settings page.

import { useEffect, useState } from "react";

type Prefs = {
  marketing_email_opt_in: boolean;
  travel_news_opt_in: boolean;
  memory_opt_out: boolean;
  performance_analytics_opt_out: boolean;
};

const LABELS: Record<keyof Prefs, { title: string; body: string }> = {
  marketing_email_opt_in: {
    title: "Marketing emails",
    body: "Promotions, special offers, and product announcements. Off by default.",
  },
  travel_news_opt_in: {
    title: "Travel news digest",
    body: "Weekly curated cruise and destination news. Off by default.",
  },
  memory_opt_out: {
    title: "Opt out of personalization memory",
    body:
      "Stops the AI from learning preferences across conversations. " +
      "Existing memory entries are preserved (use the Memory editor to delete them).",
  },
  performance_analytics_opt_out: {
    title: "Opt out of performance analytics",
    body: "Disables anonymous performance/usage telemetry from your account.",
  },
};

export default function PrivacyPage(): JSX.Element {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load(): Promise<void> {
    try {
      const res = await fetch("/api/user/privacy");
      if (!res.ok) throw new Error(`load failed: ${res.status}`);
      const body = (await res.json()) as { preferences: Partial<Prefs> };
      setPrefs({
        marketing_email_opt_in: Boolean(body.preferences.marketing_email_opt_in),
        travel_news_opt_in: Boolean(body.preferences.travel_news_opt_in),
        memory_opt_out: Boolean(body.preferences.memory_opt_out),
        performance_analytics_opt_out: Boolean(body.preferences.performance_analytics_opt_out),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggle(key: keyof Prefs): Promise<void> {
    if (!prefs) return;
    const next: Prefs = { ...prefs, [key]: !prefs[key] };
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch("/api/user/privacy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: next[key] }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? "save failed");
      }
      setPrefs(next);
      setMsg("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!prefs) return <main style={{ padding: 24 }}>Loading…</main>;

  return (
    <main style={{ padding: 24, maxWidth: 680, margin: "0 auto" }}>
      <h1>Privacy</h1>
      <p style={{ color: "#555" }}>
        Control marketing, personalization, and analytics. Cookie preferences
        are managed separately on the{" "}
        <a href="/settings/privacy/cookies">Cookies</a> page.
      </p>
      {error && <div style={{ background: "#fee2e2", padding: 12, borderRadius: 6 }}>{error}</div>}
      {msg && <div style={{ background: "#dcfce7", padding: 12, borderRadius: 6 }}>{msg}</div>}

      {(Object.keys(LABELS) as Array<keyof Prefs>).map((k) => (
        <section key={k} style={{ padding: 16, border: "1px solid #e5e7eb", borderRadius: 8, marginTop: 12 }}>
          <label style={{ display: "flex", gap: 12, alignItems: "flex-start", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={prefs[k]}
              onChange={() => toggle(k)}
              disabled={busy}
            />
            <div>
              <strong>{LABELS[k].title}</strong>
              <p style={{ margin: "4px 0 0 0", color: "#555", fontSize: 14 }}>{LABELS[k].body}</p>
            </div>
          </label>
        </section>
      ))}
    </main>
  );
}
