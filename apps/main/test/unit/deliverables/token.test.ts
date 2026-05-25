// BP39 §39.2.3 — Access token generation.

import { describe, expect, it } from "vitest";
import { newAccessToken } from "@/lib/deliverables/token";

describe("newAccessToken", () => {
  it("produces a 43-char base64url string (32 bytes)", () => {
    const t = newAccessToken();
    expect(t.length).toBe(43);
    expect(/^[A-Za-z0-9_-]{43}$/.test(t)).toBe(true);
  });

  it("produces unique values across many calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(newAccessToken());
    expect(seen.size).toBe(1000);
  });
});
