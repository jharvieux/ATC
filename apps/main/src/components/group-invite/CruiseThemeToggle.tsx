"use client";

// specs/design_handoff_group_landing/ nav bar spec: "theme toggle (sun/moon
// pill switch)". A dedicated pill rather than the shared ui/switch.tsx —
// that component is a plain checkbox-style toggle with hardcoded gray/blue
// classes; this one needs the cruise theme's own tokens and a sun/moon icon,
// not a generic on/off switch.

import { useCruiseTheme } from "@/lib/group-invite/use-cruise-theme";

export function CruiseThemeToggle() {
  const [theme, toggle] = useCruiseTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={toggle}
      className="inline-flex items-center gap-1.5 rounded-[var(--cruise-radius-pill)] border border-[var(--cruise-border)] bg-[var(--cruise-surface)] px-3 py-1.5 text-[13px] font-medium text-[var(--cruise-text)] transition-colors hover:brightness-95"
    >
      <span aria-hidden="true">{isDark ? "🌙" : "☀️"}</span>
      {isDark ? "Dark" : "Light"}
    </button>
  );
}
