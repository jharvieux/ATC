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

  if (!prefs) return <main className="p-6">Loading…</main>;

  return (
    <main className="p-6 max-w-[680px] mx-auto">
      <h1>Privacy</h1>
      <p className="text-muted-foreground">
        Control marketing, personalization, and analytics. Cookie preferences
        are managed separately on the{" "}
        <a href="/settings/privacy/cookies" className="text-primary hover:underline">Cookies</a> page.
      </p>
      {error && <div className="bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300 p-3 rounded-md">{error}</div>}
      {msg && <div className="bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 p-3 rounded-md">{msg}</div>}

      {(Object.keys(LABELS) as Array<keyof Prefs>).map((k) => (
        <section key={k} className="p-4 border border-border rounded-lg mt-3">
          <label className="flex gap-3 items-start cursor-pointer">
            <input
              type="checkbox"
              checked={prefs[k]}
              onChange={() => toggle(k)}
              disabled={busy}
              className="mt-0.5"
            />
            <div>
              <strong>{LABELS[k].title}</strong>
              <p className="mt-1 mb-0 text-muted-foreground text-[14px]">{LABELS[k].body}</p>
            </div>
          </label>
        </section>
      ))}
    </main>
  );
}
