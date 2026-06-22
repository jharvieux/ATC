"use client";

import { useCallback, useEffect, useState } from "react";
import type React from "react";

export type TaTheme = "dark" | "light";
const STORAGE_KEY = "ta-console-theme";
const THEME_EVENT = "ta-theme-change";

// ─── Shared icon button style ────────────────────────────────────────────────
// Used by TenantShell, ConsoleShell, and AdminShell. Single source of truth so
// a radius/size change propagates to all three shells automatically.
export const ICON_BTN_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  border: "none",
  borderRadius: 8,
  background: "transparent",
  cursor: "pointer",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function applyDocTheme(theme: TaTheme): void {
  document.documentElement.setAttribute("data-ta-theme", theme);
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function readInitialTheme(): TaTheme {
  const saved = localStorage.getItem(STORAGE_KEY) as TaTheme | null;
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

/**
 * Reads and toggles the TA dark/light theme. Persists to localStorage,
 * writes `data-ta-theme` on `document.documentElement`, and stays in sync
 * with other mounted consumers via the `ta-theme-change` custom event.
 *
 * Use this in shells that own a toggle button (TenantShell, ConsoleShell,
 * AdminShell). Use `useTaThemeSync` in components that only need to react to
 * theme changes without owning a toggle (ConciergeExperience).
 */
export function useTaTheme(): [TaTheme, () => void] {
  const [theme, setTheme] = useState<TaTheme>("dark");

  useEffect(() => {
    const initial = readInitialTheme();
    setTheme(initial);
    applyDocTheme(initial);

    const onExternalChange = (e: Event): void => {
      const next = (e as CustomEvent<TaTheme>).detail as TaTheme;
      setTheme(next);
    };
    window.addEventListener(THEME_EVENT, onExternalChange);
    return () => window.removeEventListener(THEME_EVENT, onExternalChange);
  }, []);

  const toggle = useCallback((): void => {
    setTheme((prev) => {
      const next: TaTheme = prev === "dark" ? "light" : "dark";
      localStorage.setItem(STORAGE_KEY, next);
      applyDocTheme(next);
      window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: next }));
      return next;
    });
  }, []);

  return [theme, toggle];
}

/**
 * Subscribe-only variant for components that need the TA theme applied to
 * `document.documentElement` on mount but do not own a toggle button.
 * Registers the `ta-theme-change` listener so external toggles (e.g. the
 * TenantShell header button) keep this component's parent layout in sync.
 */
export function useTaThemeSync(): void {
  useEffect(() => {
    applyDocTheme(readInitialTheme());

    const onExternalChange = (e: Event): void => {
      applyDocTheme((e as CustomEvent<TaTheme>).detail as TaTheme);
    };
    window.addEventListener(THEME_EVENT, onExternalChange);
    return () => window.removeEventListener(THEME_EVENT, onExternalChange);
  }, []);
}
