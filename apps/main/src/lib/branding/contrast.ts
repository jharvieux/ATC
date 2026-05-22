// §16.2 — WCAG AA contrast check.
//
// Uses the standard sRGB → relative-luminance formula (W3C). We compute the
// contrast ratio between a foreground color and a background, then compare
// against WCAG AA thresholds:
//   - Normal text: ≥ 4.5
//   - Large text (≥18pt or 14pt bold): ≥ 3.0

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.replace(/^#/, "");
  if (m.length !== 6) return null;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return { r, g, b };
}

function srgbChannel(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return 0.2126 * srgbChannel(rgb.r) + 0.7152 * srgbChannel(rgb.g) + 0.0722 * srgbChannel(rgb.b);
}

export function contrastRatio(fgHex: string, bgHex: string): number | null {
  const fg = relativeLuminance(fgHex);
  const bg = relativeLuminance(bgHex);
  if (fg === null || bg === null) return null;
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface ContrastCheck {
  ratio: number;
  passes_aa_normal: boolean;
  passes_aa_large: boolean;
}

export function checkContrast(fgHex: string, bgHex: string): ContrastCheck | null {
  const r = contrastRatio(fgHex, bgHex);
  if (r === null) return null;
  return {
    ratio: Math.round(r * 100) / 100,
    passes_aa_normal: r >= 4.5,
    passes_aa_large: r >= 3.0,
  };
}
