"use client";

// §25.8 — Cookie preferences settings page (revisable).

import { useEffect, useState } from "react";

const COOKIE_NAME = "cookie_preferences";

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const target = `${name}=`;
  for (const p of document.cookie.split(";")) {
    const t = p.trim();
    if (t.startsWith(target)) return decodeURIComponent(t.slice(target.length));
  }
  return null;
}

function writeCookie(name: string, value: string): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
}

export default function CookieSettingsPage(): JSX.Element {
  const [performance, setPerformance] = useState(true);
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const raw = readCookie(COOKIE_NAME);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { performance?: boolean; marketing?: boolean };
        setPerformance(Boolean(parsed.performance));
        setMarketing(Boolean(parsed.marketing));
      } catch {
        // ignore malformed cookie
      }
    }
  }, []);

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    const payload = { performance, marketing, set_at: new Date().toISOString() };
    writeCookie(COOKIE_NAME, JSON.stringify(payload));
    try {
      await fetch("/api/user/privacy/cookies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      setMsg("Saved.");
    } catch {
      setMsg("Saved locally; server sync failed (re-try later).");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ padding: 24, maxWidth: 680, margin: "0 auto" }}>
      <h1>Cookies</h1>
      <p style={{ color: "#555" }}>
        Update your cookie preferences. Essential cookies are always on
        (session, security). See the{" "}
        <a href="/legal/sub-processors">sub-processors</a> list for who handles what.
      </p>

      <section style={{ marginTop: 16, padding: 16, border: "1px solid #e5e7eb", borderRadius: 8 }}>
        <strong>Essential</strong>
        <p style={{ margin: "4px 0 0 0", color: "#555" }}>Always on. Session, security, basic preferences.</p>
      </section>

      <section style={{ marginTop: 12, padding: 16, border: "1px solid #e5e7eb", borderRadius: 8 }}>
        <label>
          <input type="checkbox" checked={performance} onChange={(e) => setPerformance(e.target.checked)} />{" "}
          <strong>Performance</strong> — analytics (default on)
        </label>
      </section>

      <section style={{ marginTop: 12, padding: 16, border: "1px solid #e5e7eb", borderRadius: 8 }}>
        <label>
          <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />{" "}
          <strong>Marketing</strong> — cross-site retargeting (default off)
        </label>
      </section>

      <div style={{ marginTop: 16 }}>
        <button type="button" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save preferences"}
        </button>
        {msg && <span style={{ marginLeft: 12, color: "#16a34a" }}>{msg}</span>}
      </div>
    </main>
  );
}
