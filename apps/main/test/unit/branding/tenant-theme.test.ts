// §16.2 — tenant colors are "applied via CSS custom properties at
// runtime". These helpers are the only translation layer between the
// hex values tenants save and the shadcn HSL tokens the whole UI reads;
// a silent regression here re-skins every tenant page (or none).

import { describe, it, expect } from "vitest";
import {
  hexToHslTriple,
  contrastRatio,
  contrastWarning,
  sanitizeFontFamily,
  googleFontHrefFor,
  buildTenantThemeCss,
} from "@/lib/branding/tenant-theme";

describe("hexToHslTriple", () => {
  it("matches the canonical tailwind value for blue-600", () => {
    // Why: the emitted triple is consumed as `hsl(var(--primary))` —
    // a wrong conversion renders every brand color subtly off. blue-600
    // has a published HSL (221.2 83.2% 53.3%) to pin against.
    expect(hexToHslTriple("#2563eb")).toBe("221.2 83.2% 53.3%");
  });

  it("handles the achromatic edge (white) without dividing by zero", () => {
    expect(hexToHslTriple("#ffffff")).toBe("0 0% 100%");
  });

  it("rejects anything that isn't a 6-digit hex", () => {
    // Why: the API accepts only #RRGGBB but the builder must not trust
    // that — a malformed stored value must drop the var, not emit
    // garbage CSS that silently kills the whole :root block.
    expect(hexToHslTriple("red")).toBeNull();
    expect(hexToHslTriple("#fff")).toBeNull();
    expect(hexToHslTriple(null)).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("returns the WCAG-defined 21:1 for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  it("is symmetric in its arguments", () => {
    expect(contrastRatio("#2563eb", "#ffffff")).toBeCloseTo(
      contrastRatio("#ffffff", "#2563eb") as number,
      10,
    );
  });

  it("returns null on invalid input instead of a fake ratio", () => {
    expect(contrastRatio("nope", "#ffffff")).toBeNull();
  });
});

describe("contrastWarning (§16.2 WCAG AA)", () => {
  it("warns when a pale color will wash out on light backgrounds", () => {
    // Why: a tenant picking pale yellow as primary gets near-invisible
    // buttons in light mode; the spec requires warning, not blocking.
    expect(contrastWarning("#facc15")).toMatch(/light backgrounds/);
  });

  it("warns when a near-black color disappears in dark mode", () => {
    expect(contrastWarning("#0f172a")).toMatch(/dark backgrounds/);
  });

  it("stays quiet for a color readable on both backgrounds", () => {
    // Mid-saturation blue clears 3:1 against white AND near-black.
    expect(contrastWarning("#2563eb")).toBeNull();
  });
});

describe("sanitizeFontFamily", () => {
  it("strips CSS-escaping characters so a stored value can't break out of the declaration", () => {
    // Why: font_family is tenant-supplied text interpolated into a
    // <style> tag — braces/semicolons/angle-brackets are how an
    // injection would escape the `font-family:` declaration.
    const out = sanitizeFontFamily('Inter; } body { background: url(x) } </style>');
    expect(out).toMatch(/^[A-Za-z0-9 ,'"-]*$/);
    expect(out).not.toMatch(/[;{}<>()/]/);
  });

  it("passes a legitimate stack through unchanged", () => {
    expect(sanitizeFontFamily("Inter, system-ui, sans-serif")).toBe(
      "Inter, system-ui, sans-serif",
    );
  });

  it("returns null for empty/whitespace input so callers skip the rule", () => {
    expect(sanitizeFontFamily("   ")).toBeNull();
    expect(sanitizeFontFamily(null)).toBeNull();
  });
});

describe("googleFontHrefFor", () => {
  it("builds a css2 URL for the first family of a Google-font stack", () => {
    expect(googleFontHrefFor("Playfair Display, serif")).toBe(
      "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700&display=swap",
    );
  });

  it("strips quotes around the family name", () => {
    expect(googleFontHrefFor("'Inter', sans-serif")).toContain("family=Inter:");
  });

  it("skips system faces and CSS generics — no pointless network request", () => {
    // Why: §16.2 allows "Google Font name OR system stack"; a system
    // stack must not trigger a fonts.googleapis.com fetch on every page.
    expect(googleFontHrefFor("Arial, sans-serif")).toBeNull();
    expect(googleFontHrefFor("system-ui")).toBeNull();
    expect(googleFontHrefFor(null)).toBeNull();
  });
});

describe("buildTenantThemeCss", () => {
  const empty = {
    primary_color: null,
    secondary_color: null,
    accent_color: null,
    font_family: null,
  };

  it("returns null when nothing is set so callers can skip the <style> tag", () => {
    expect(buildTenantThemeCss(empty)).toBeNull();
  });

  it("emits only the token groups whose color is set", () => {
    // Why: a tenant who customized just their primary color must keep
    // the platform defaults for secondary/accent — emitting empty or
    // fabricated values for unset fields would override globals.css.
    const css = buildTenantThemeCss({ ...empty, primary_color: "#2563eb" });
    expect(css).toContain("--primary: 221.2 83.2% 53.3%;");
    expect(css).toContain("--ring: 221.2 83.2% 53.3%;");
    expect(css).not.toContain("--secondary");
    expect(css).not.toContain("--accent");
  });

  it("computes a readable foreground for the brand color", () => {
    // Why: tenants pick one hex; the text on top of it is ours to get
    // right. Dark brand → white text, light brand → near-black text.
    const dark = buildTenantThemeCss({ ...empty, primary_color: "#2563eb" });
    expect(dark).toContain("--primary-foreground: 0 0% 100%;");
    const light = buildTenantThemeCss({ ...empty, primary_color: "#facc15" });
    expect(light).toContain("--primary-foreground: 0 0% 4%;");
  });

  it("ignores malformed colors instead of emitting broken CSS", () => {
    expect(buildTenantThemeCss({ ...empty, primary_color: "blue" })).toBeNull();
  });

  it("emits a body font rule without requiring any color", () => {
    const css = buildTenantThemeCss({ ...empty, font_family: "Inter, sans-serif" });
    expect(css).toBe("body { font-family: Inter, sans-serif; }");
  });
});
