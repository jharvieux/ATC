// §16.2 — Tenant color/font theming, applied via CSS custom properties
// at runtime. Pure functions (no DB, no next/headers) so both the server
// theme injector (TenantTheme.tsx) and the client settings form (contrast
// warnings) can share them.
//
// Token mapping (shadcn HSL-triple tokens from globals.css):
//   primary_color   → --primary / --primary-foreground / --ring
//   secondary_color → --secondary / --secondary-foreground
//   accent_color    → --accent / --accent-foreground
// Foregrounds are computed (white or near-black, whichever contrasts
// better) so tenant-colored buttons stay readable regardless of the hex
// the tenant picked.

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string | null | undefined): Rgb | null {
  if (!hex || !HEX_RE.test(hex)) return null;
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

/** Format a number for an HSL triple: one decimal, no trailing ".0". */
function fmt(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/**
 * Convert "#RRGGBB" to a shadcn-style space-separated HSL triple, e.g.
 * "#2563eb" → "221.2 83.2% 53.3%" (consumed as `hsl(var(--primary))`).
 * Returns null for anything that isn't a 6-digit hex color.
 */
export function hexToHslTriple(hex: string | null | undefined): string | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return `${fmt(h)} ${fmt(s * 100)}% ${fmt(l * 100)}%`;
}

/** WCAG 2.x relative luminance of an sRGB color (0 = black, 1 = white). */
function relativeLuminance(rgb: Rgb): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

/**
 * WCAG contrast ratio between two hex colors, 1–21. Null when either
 * input isn't a valid 6-digit hex.
 */
export function contrastRatio(hexA: string, hexB: string): number | null {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return null;
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// Near-black/white foreground triples matching the app's own
// --foreground values in globals.css (4% / 100% lightness).
const FG_DARK = "0 0% 4%";
const FG_LIGHT = "0 0% 100%";

function foregroundTripleFor(hex: string): string {
  const vsWhite = contrastRatio(hex, "#ffffff") ?? 0;
  const vsBlack = contrastRatio(hex, "#000000") ?? 0;
  return vsWhite >= vsBlack ? FG_LIGHT : FG_DARK;
}

// Page backgrounds the brand colors will sit on: light mode is white,
// dark mode is hsl(0 0% 4%) ≈ #0a0a0a (globals.css --background values).
const LIGHT_BG = "#ffffff";
const DARK_BG = "#0a0a0a";

/**
 * §16.2 contrast warning for the settings form. 3:1 is the WCAG AA
 * minimum for non-text UI elements (SC 1.4.11) — below that a brand-
 * colored button or link visually washes out against the page
 * background. Non-blocking: the tenant can still save.
 */
export function contrastWarning(hex: string): string | null {
  const vsLight = contrastRatio(hex, LIGHT_BG);
  const vsDark = contrastRatio(hex, DARK_BG);
  if (vsLight === null || vsDark === null) return null;
  const failsLight = vsLight < 3;
  const failsDark = vsDark < 3;
  if (failsLight && failsDark) {
    return "Low contrast against both light and dark backgrounds (WCAG AA needs 3:1) — this color may be hard to see.";
  }
  if (failsLight) {
    return "Low contrast against light backgrounds (WCAG AA needs 3:1) — this color may wash out in light mode.";
  }
  if (failsDark) {
    return "Low contrast against dark backgrounds (WCAG AA needs 3:1) — this color may be hard to see in dark mode.";
  }
  return null;
}

/**
 * Strip anything that could escape a CSS declaration (`;`, braces,
 * `</style>` injection, `url(...)`). Letters, digits, spaces, commas,
 * hyphens, and quotes cover every legitimate font stack.
 */
export function sanitizeFontFamily(input: string | null | undefined): string | null {
  if (!input) return null;
  const cleaned = input.replace(/[^A-Za-z0-9 ,'"-]/g, "").trim().slice(0, 120);
  return cleaned.length > 0 ? cleaned : null;
}

// Families that never need a Google Fonts request: CSS generics plus the
// universally pre-installed system faces. Everything else gets a
// fonts.googleapis.com stylesheet — if the name isn't actually a Google
// font the request 404s and the browser just falls back down the stack.
const SYSTEM_FONTS = new Set([
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "-apple-system",
  "blinkmacsystemfont",
  "segoe ui",
  "arial",
  "helvetica",
  "helvetica neue",
  "georgia",
  "times",
  "times new roman",
  "verdana",
  "tahoma",
  "trebuchet ms",
  "courier",
  "courier new",
]);

/**
 * Google Fonts stylesheet URL for the first family in the tenant's font
 * stack (§16.2: "Google Font name or system stack"). Null when the first
 * family is a system/generic font or the stack is empty.
 */
export function googleFontHrefFor(fontFamily: string | null | undefined): string | null {
  const sanitized = sanitizeFontFamily(fontFamily);
  if (!sanitized) return null;
  const first = (sanitized.split(",")[0] ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
  if (!first || SYSTEM_FONTS.has(first.toLowerCase())) return null;
  const family = first.split(/\s+/).join("+");
  return `https://fonts.googleapis.com/css2?family=${family}:wght@400;500;600;700&display=swap`;
}

export interface TenantThemeInput {
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  font_family: string | null;
}

/**
 * Build the runtime `<style>` payload for a tenant's theme. Only fields
 * that parse are emitted; returns null when nothing is set so callers
 * can skip the tag entirely.
 *
 * Deliberately UNLAYERED css: globals.css defines the default tokens
 * inside `@layer base`, and unlayered declarations beat layered ones
 * regardless of order or specificity — so a single `:root` block here
 * overrides both the light defaults and the `.dark` overrides. The
 * tenant picks one palette that applies in both color schemes; the
 * computed foregrounds keep brand-colored controls readable on either.
 */
export function buildTenantThemeCss(theme: TenantThemeInput): string | null {
  const vars: string[] = [];

  // The second operand of each guard narrows the field to string for
  // foregroundTripleFor — not redundant, don't simplify away.
  const primary = hexToHslTriple(theme.primary_color);
  if (primary && theme.primary_color) {
    vars.push(
      `--primary: ${primary};`,
      `--primary-foreground: ${foregroundTripleFor(theme.primary_color)};`,
      `--ring: ${primary};`,
    );
  }
  const secondary = hexToHslTriple(theme.secondary_color);
  if (secondary && theme.secondary_color) {
    vars.push(
      `--secondary: ${secondary};`,
      `--secondary-foreground: ${foregroundTripleFor(theme.secondary_color)};`,
    );
  }
  const accent = hexToHslTriple(theme.accent_color);
  if (accent && theme.accent_color) {
    vars.push(
      `--accent: ${accent};`,
      `--accent-foreground: ${foregroundTripleFor(theme.accent_color)};`,
    );
  }

  const rules: string[] = [];
  if (vars.length > 0) rules.push(`:root { ${vars.join(" ")} }`);

  const font = sanitizeFontFamily(theme.font_family);
  if (font) rules.push(`body { font-family: ${font}; }`);

  return rules.length > 0 ? rules.join("\n") : null;
}
