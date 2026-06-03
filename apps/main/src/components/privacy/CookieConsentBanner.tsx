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
import { Button } from "@/components/ui/button";

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
      className="fixed bottom-4 left-4 right-4 max-w-[720px] mx-auto p-5 bg-gray-900 text-white rounded-lg shadow-2xl z-[1000]"
    >
      <p className="mb-3 leading-[1.5]">
        We use cookies to operate the platform, measure performance, and
        optionally personalize. You can pick what you&rsquo;re comfortable with.
        See <a href="/legal/sub-processors" className="text-blue-300 hover:underline">sub-processors</a> for who handles what.
      </p>
      {customize && (
        <div className="bg-white/5 p-3 rounded-md mb-3">
          <div className="mb-2">
            <strong>Essential</strong> — always on (session, security).
          </div>
          <label className="block mb-2">
            <input
              type="checkbox"
              checked={performance}
              onChange={(e) => setPerformance(e.target.checked)}
              className="mr-1.5"
            />
            Performance (analytics)
          </label>
          <label className="block">
            <input
              type="checkbox"
              checked={marketing}
              onChange={(e) => setMarketing(e.target.checked)}
              className="mr-1.5"
            />
            Marketing (cross-site retargeting)
          </label>
        </div>
      )}
      <div className="flex gap-2 flex-wrap">
        {!customize && (
          <>
            <Button type="button" onClick={() => save({ performance: true, marketing: true })}>
              Accept all
            </Button>
            <Button type="button" variant="outline" onClick={() => save({ performance: false, marketing: false })}
              className="border-white text-white hover:bg-white/10 hover:text-white bg-transparent">
              Essential only
            </Button>
            <Button type="button" variant="outline" onClick={() => setCustomize(true)}
              className="border-white text-white hover:bg-white/10 hover:text-white bg-transparent">
              Customize
            </Button>
          </>
        )}
        {customize && (
          <Button type="button" onClick={() => save({ performance, marketing })}>
            Save preferences
          </Button>
        )}
      </div>
    </div>
  );
}
