// Tests for platformBaseUrl() (§15.8/§15.9 Stripe redirect origin).
//
// WHY: before this helper the Stripe redirect routes fell back to a hardcoded
// localhost URL when their env var was unset — fail-open, so a paying user would
// be redirected to a dead URL after checkout with no error anywhere. The throw
// path is the whole point of the helper; a regression back to a localhost
// fallback must fail a test, not ship silently.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { platformBaseUrl } from "@/lib/platform-url";

let original: NodeJS.ProcessEnv;

beforeEach(() => {
  original = process.env;
  process.env = { ...original };
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.PLATFORM_PRIMARY_DOMAIN;
});

afterEach(() => {
  process.env = original;
});

describe("platformBaseUrl", () => {
  it("returns NEXT_PUBLIC_APP_URL (trimmed) when set", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com/";
    expect(platformBaseUrl()).toBe("https://app.example.com");
  });

  it("prefers NEXT_PUBLIC_APP_URL over PLATFORM_PRIMARY_DOMAIN", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
    process.env.PLATFORM_PRIMARY_DOMAIN = "other.example.com";
    expect(platformBaseUrl()).toBe("https://app.example.com");
  });

  it("falls back to https://PLATFORM_PRIMARY_DOMAIN when NEXT_PUBLIC_APP_URL is unset", () => {
    process.env.PLATFORM_PRIMARY_DOMAIN = "tenant.example.com/";
    expect(platformBaseUrl()).toBe("https://tenant.example.com");
  });

  it("throws (fail-loud, never localhost) when neither var is set", () => {
    expect(() => platformBaseUrl()).toThrow(/neither NEXT_PUBLIC_APP_URL nor PLATFORM_PRIMARY_DOMAIN/);
  });
});
