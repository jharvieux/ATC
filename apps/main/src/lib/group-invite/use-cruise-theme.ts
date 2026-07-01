"use client";

// specs/design_handoff_group_landing/ — "Bright & Vacation-y" theme.
// Mirrors lib/ta-theme/use-ta-theme.ts: own storage key, own custom event,
// applies data-cruise-theme to document.documentElement. Deliberately not
// the app-wide next-themes ThemeProvider (that one drives the global `.dark`
// class for the rest of the app) — a customer's landing-page preference
// must not leak into, or be overridden by, the rest of the app's theme.
// Harmless to set on documentElement globally: no CSS outside
// [data-cruise-theme] scoped rules reads this attribute.

import { useCallback, useEffect, useState } from "react";

export type CruiseTheme = "light" | "dark";
const STORAGE_KEY = "cruise-theme";
const THEME_EVENT = "cruise-theme-change";

function applyDocTheme(theme: CruiseTheme): void {
  document.documentElement.setAttribute("data-cruise-theme", theme);
}

function readInitialTheme(): CruiseTheme {
  const saved = localStorage.getItem(STORAGE_KEY) as CruiseTheme | null;
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Reads and toggles the cruise theme. Persists to localStorage, writes
 * `data-cruise-theme` on `document.documentElement`, and stays in sync with
 * other mounted consumers via the `cruise-theme-change` custom event.
 */
export function useCruiseTheme(): [CruiseTheme, () => void] {
  const [theme, setTheme] = useState<CruiseTheme>("light");

  useEffect(() => {
    const initial = readInitialTheme();
    setTheme(initial);
    applyDocTheme(initial);

    const onExternalChange = (e: Event): void => {
      setTheme((e as CustomEvent<CruiseTheme>).detail);
    };
    window.addEventListener(THEME_EVENT, onExternalChange);
    return () => window.removeEventListener(THEME_EVENT, onExternalChange);
  }, []);

  const toggle = useCallback((): void => {
    setTheme((prev) => {
      const next: CruiseTheme = prev === "dark" ? "light" : "dark";
      localStorage.setItem(STORAGE_KEY, next);
      applyDocTheme(next);
      window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: next }));
      return next;
    });
  }, []);

  return [theme, toggle];
}
