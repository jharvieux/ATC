// BP35 §35.2.1 — URL UTM extraction tests.

import { describe, expect, it } from "vitest";
import { extractAttributionFromRequest } from "@/lib/attribution/extract-utm";

describe("extractAttributionFromRequest", () => {
  it("returns null when no utm_* params present (even with referrer)", () => {
    const r = extractAttributionFromRequest({
      url: new URL("https://tenant.example.com/landing"),
      referrer: "https://google.com/",
    });
    expect(r).toBeNull();
  });

  it("captures full UTM payload with derived channel", () => {
    const r = extractAttributionFromRequest({
      url: new URL("https://tenant.example.com/page?utm_source=facebook&utm_medium=social&utm_campaign=wave2027&utm_content=ad1&utm_term=alaska"),
      referrer: "https://facebook.com/x",
    });
    expect(r).not.toBeNull();
    expect(r!.utm_source).toBe("facebook");
    expect(r!.utm_medium).toBe("social");
    expect(r!.utm_campaign).toBe("wave2027");
    expect(r!.utm_content).toBe("ad1");
    expect(r!.utm_term).toBe("alaska");
    expect(r!.channel).toBe("social");
    expect(r!.referrer_url).toBe("https://facebook.com/x");
    expect(r!.landing_path).toBe("/page");
    expect(typeof r!.captured_at).toBe("string");
  });

  it("lowercases UTM values", () => {
    const r = extractAttributionFromRequest({
      url: new URL("https://x.com/?utm_source=Facebook&utm_medium=CPC"),
      referrer: null,
    });
    expect(r!.utm_source).toBe("facebook");
    expect(r!.utm_medium).toBe("cpc");
    expect(r!.channel).toBe("search");
  });

  it("captures partial UTM (just source)", () => {
    const r = extractAttributionFromRequest({
      url: new URL("https://x.com/?utm_source=newsletter"),
      referrer: null,
    });
    expect(r!.utm_source).toBe("newsletter");
    expect(r!.utm_medium).toBeNull();
    expect(r!.channel).toBe("direct"); // no medium → direct
  });

  it("ignores empty-string UTM values", () => {
    const r = extractAttributionFromRequest({
      url: new URL("https://x.com/?utm_source=&utm_medium="),
      referrer: null,
    });
    expect(r).toBeNull();
  });
});
