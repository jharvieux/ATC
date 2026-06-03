"use client";

// §25.8 — Cookie consent banner.
//
// First visit: show banner with three options (Accept all / Essential only /
// Customize). Persist to first-party 'cookie_preferences' cookie + mirror
// to users.cookie_preferences for authenticated users.
//
// Categories per §25.8:
//   • essential    — always on, non-toggle (session, security, basic prefs)
//   • performance  — opt-out default ON (analytics)
//   • marketing    — opt-in default OFF (cross-site retargeting)

import { useEffect, useState } from "react";

const COOKIE_NAME = "cookie_preferences";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year

export interface CookiePreferences {
  performance: boolean;
  marketing: boolean;
  set_at: string;
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const target = `${name}=`;
  const parts = document.cookie.split(";");
  for (const p of parts) {
    const trimmed = p.trim();
    if (trimmed.startsWith(target)) return decodeURIComponent(trimmed.slice(target.length));
  }
  return null;
}

function writeCookie(name: string, value: string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

async function persistToServer(prefs: CookiePreferences): Promise<void> {
  try {
    await fetch("/api/user/privacy/cookies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prefs),
    });
  } catch {
    // Best-effort — the cookie is the persistence layer; server mirror is bonus.
  }
}

export function CookieConsentBanner(): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [customize, setCustomize] = useState(false);
  const [performance, setPerformance] = useState(true);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    const existing = readCookie(COOKIE_NAME);
    if (!existing) {
      setOpen(true);
    }
    // Already chosen — don't re-show.
  }, []);

  function save(prefs: { performance: boolean; marketing: boolean }): void {
    const payload: CookiePreferences = { ...prefs, set_at: new Date().toISOString() };
    writeCookie(COOKIE_NAME, JSON.stringify(payload));
    void persistToServer(payload);
    setOpen(false);
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Cookie preferences"
      style={{
        position: "fixed",
        bottom: 16,
        left: 16,
        right: 16,
        maxWidth: 720,
        margin: "0 auto",
        padding: 20,
        background: "#1f2937",
        color: "#fff",
        borderRadius: 8,
        boxShadow: "0 10px 25px rgba(0,0,0,0.25)",
        zIndex: 1000,
      }}
    >
      <p style={{ margin: "0 0 12px 0", lineHeight: 1.5 }}>
        We use cookies to operate the platform, measure performance, and
        optionally personalize. You can pick what you&rsquo;re comfortable with.
        See <a href="/legal/sub-processors" style={{ color: "#93c5fd" }}>sub-processors</a> for who handles what.
      </p>
      {customize && (
        <div style={{ background: "rgba(255,255,255,0.05)", padding: 12, borderRadius: 6, marginBottom: 12 }}>
          <div style={{ marginBottom: 8 }}>
            <strong>Essential</strong> — always on (session, security).
          </div>
          <label style={{ display: "block", marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={performance}
              onChange={(e) => setPerformance(e.target.checked)}
            />{" "}
            Performance (analytics)
          </label>
          <label style={{ display: "block" }}>
            <input
              type="checkbox"
              checked={marketing}
              onChange={(e) => setMarketing(e.target.checked)}
            />{" "}
            Marketing (cross-site retargeting)
          </label>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {!customize && (
          <>
            <button type="button" onClick={() => save({ performance: true, marketing: true })}
              style={{ background: "#3b82f6", color: "#fff", border: "none", padding: "8px 14px", borderRadius: 6 }}>
              Accept all
            </button>
            <button type="button" onClick={() => save({ performance: false, marketing: false })}
              style={{ background: "transparent", color: "#fff", border: "1px solid #fff", padding: "8px 14px", borderRadius: 6 }}>
              Essential only
            </button>
            <button type="button" onClick={() => setCustomize(true)}
              style={{ background: "transparent", color: "#fff", border: "1px solid #fff", padding: "8px 14px", borderRadius: 6 }}>
              Customize
            </button>
          </>
        )}
        {customize && (
          <button type="button" onClick={() => save({ performance, marketing })}
            style={{ background: "#3b82f6", color: "#fff", border: "none", padding: "8px 14px", borderRadius: 6 }}>
            Save preferences
          </button>
        )}
      </div>
    </div>
  );
}
