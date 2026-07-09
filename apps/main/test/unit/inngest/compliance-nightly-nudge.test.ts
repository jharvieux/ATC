// §compliance — compliance-nightly recompute core (P3 for #1217).
//
// File was 1% (169 NoCoverage) in the 2026-06-17 Stryker sweep. The pure core
// worth pinning is the inactivity-level selection (which reminder a tenant
// trips). The mailing-address formatter used to live here too (formatAddress)
// but was consolidated into the shared formatMailingAddress (#1556) — its
// coverage moved to test/unit/lib/format-mailing-address.test.ts.

import { describe, it, expect } from "vitest";
import { selectNudgeLevel } from "@/inngest/compliance-nightly";

describe("selectNudgeLevel — most severe applicable level, 30d floor", () => {
  it("returns null below the 30-day floor", () => {
    expect(selectNudgeLevel(0)).toBeNull();
    expect(selectNudgeLevel(29)).toBeNull();
  });

  it("trips 30d at exactly 30 days and holds until 60", () => {
    expect(selectNudgeLevel(30)).toBe("30d");
    expect(selectNudgeLevel(59)).toBe("30d");
  });

  it("trips 60d at exactly 60 and holds until 90", () => {
    expect(selectNudgeLevel(60)).toBe("60d");
    expect(selectNudgeLevel(89)).toBe("60d");
  });

  it("trips 90d at exactly 90 and holds until 180", () => {
    expect(selectNudgeLevel(90)).toBe("90d");
    expect(selectNudgeLevel(179)).toBe("90d");
  });

  // The key anti-regression: a long-idle tenant must trip ONLY the most severe
  // level, never a lower reminder it skipped past.
  it("trips 180d at 180 and stays there for very long inactivity", () => {
    expect(selectNudgeLevel(180)).toBe("180d");
    expect(selectNudgeLevel(3650)).toBe("180d");
  });
});
