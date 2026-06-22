"use client";

import { useCallback, useEffect, useState } from "react";

export type TaTheme = "dark" | "light";
const STORAGE_KEY = "ta-console-theme";
const THEME_EVENT = "ta-theme-change";

function applyDocTheme(theme: TaTheme): void {
  document.documentElement.setAttribute("data-ta-theme", theme);
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function useTaTheme(): [TaTheme, () => void] {
  const [theme, setTheme] = useState<TaTheme>("dark");

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as TaTheme | null;
    const initial: TaTheme =
      saved === "dark" || saved === "light"
        ? saved
        : window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
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
