// §3.3 / §15.8 / §15.15 — TIER_CODE + CODE_TO_TIER round-trip consistency (#1121)
//
// WHY: TIER_CODE maps {tenant_type, tier} → TierCode; CODE_TO_TIER is the
// reverse. If a future edit adds a code to one map but not the other, routes
// that rely on the round-trip (tier/route.ts, billing/route.ts, subscription/
// checkout/route.ts) silently mis-bill or reject valid tenants. No tsc guard
// catches a string-literal inconsistency between the two objects.

import { describe, it, expect } from "vitest";
import { TIER_CODE, CODE_TO_TIER } from "@/lib/stripe/tier-codes";

describe("TIER_CODE / CODE_TO_TIER round-trip consistency §3.3", () => {
  const allCodes = Object.values(TIER_CODE).flatMap((tierMap) => Object.values(tierMap));
  const uniqueCodes = [...new Set(allCodes)];

  it("every code emitted by TIER_CODE has a reverse entry in CODE_TO_TIER", () => {
    for (const code of uniqueCodes) {
      expect(CODE_TO_TIER, `CODE_TO_TIER is missing entry for code "${code}" from TIER_CODE`).toHaveProperty(code);
    }
  });

  it("every key in CODE_TO_TIER maps back to a value that exists in TIER_CODE — no stale entries", () => {
    for (const code of Object.keys(CODE_TO_TIER)) {
      expect(uniqueCodes, `CODE_TO_TIER has stale key "${code}" not reachable from TIER_CODE`).toContain(code);
    }
  });

  it("TIER_CODE and CODE_TO_TIER are perfectly complementary — same cardinality", () => {
    expect(Object.keys(CODE_TO_TIER).length).toBe(uniqueCodes.length);
  });
});
