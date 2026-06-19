// BP32 §32.10.1 — bug-intent recognizer.

import { describe, it, expect, vi } from "vitest";

// #1190: the flow is gated by the platform flag only — no per-tenant opt-out.
vi.mock("@/lib/env", () => ({ env: () => ({ PHASE_2_CUSTOMER_BUG_FLOW_ENABLED: true }) }));

import {
  matchesAnySeedPhrase,
  OFFER_MESSAGE,
  detectBugIntent,
} from "@/lib/help-ai/bug-intent-recognizer";

// Minimal db that records which tables are read; platform_settings returns no
// extra phrases. tenant_settings must NEVER be queried (#1190 removed that gate).
function makeDb(tablesRead: string[]) {
  return {
    from(table: string) {
      tablesRead.push(table);
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) };
    },
  } as unknown as Parameters<typeof detectBugIntent>[0]["db"];
}

describe("matchesAnySeedPhrase", () => {
  it("matches 'this is broken' anywhere in the message", () => {
    expect(matchesAnySeedPhrase("hey, this is broken on the search page")).toBe("this is broken");
  });

  it("matches case-insensitively", () => {
    expect(matchesAnySeedPhrase("THIS IS BROKEN")).toBe("this is broken");
  });

  it("matches 'i think there's a bug'", () => {
    expect(matchesAnySeedPhrase("I think there's a bug with the date picker")).toBe("i think there's a bug");
  });

  it("matches the contraction-free variant 'i think there is a bug'", () => {
    expect(matchesAnySeedPhrase("I think there is a bug")).toBe("i think there is a bug");
  });

  it("matches 'the website crashed'", () => {
    expect(matchesAnySeedPhrase("Hi, the website crashed when I clicked submit")).toBe("the website crashed");
  });

  it("returns null for messages without trigger phrases", () => {
    expect(matchesAnySeedPhrase("Hi, can you help me find a cruise to Alaska?")).toBe(null);
  });

  it("OFFER_MESSAGE is the §32.10.1 verbatim text", () => {
    expect(OFFER_MESSAGE).toMatch(/sounds like something might not be working/i);
    expect(OFFER_MESSAGE).toMatch(/file a bug report/i);
    expect(OFFER_MESSAGE).toMatch(/engineering team/i);
  });
});

describe("detectBugIntent — platform-flag-only gate (#1190)", () => {
  it("triggers on a seed phrase without ever reading tenant_settings", async () => {
    const tablesRead: string[] = [];
    const result = await detectBugIntent({
      message: "hey, this is broken on the search page",
      db: makeDb(tablesRead),
    });

    expect(result.triggered).toBe(true);
    expect(result.matched_phrase).toBe("this is broken");
    // The removed per-tenant gate must not come back — no tenant_settings read.
    expect(tablesRead).not.toContain("tenant_settings");
  });

  it("does not trigger on a non-bug message", async () => {
    const result = await detectBugIntent({
      message: "can you help me find a cruise to Alaska?",
      db: makeDb([]),
    });
    expect(result.triggered).toBe(false);
  });
});
