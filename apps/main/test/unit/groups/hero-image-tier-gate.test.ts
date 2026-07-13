// §18.3 / #444 — hero-image AI generation tier gate.
//
// WHY: AI_ELIGIBLE_TIERS originally held phantom codes ("sub_host_pro",
// "sub_host_agency") that don't exist in tier_definitions, so the AI path
// was dead for sub-host tenants and nothing failed loudly. The consistency
// test pins every gate entry to a real §3.3 tier code; the behavior tests
// pin that a real pro/agency code opens the gate and an unknown tier (null)
// falls through to the cruise-line default without any generation attempt.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AI_ELIGIBLE_TIERS, selectHeroImage } from "@/lib/groups/hero-image";
import { CODE_TO_TIER_MAP } from "@/lib/stripe/tier-code-map";

vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: vi.fn(async () => {}),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "destination_images") {
        // Library lookup: .select("image_url").eq(...).limit(1).maybeSingle()
        return {
          select: () => ({
            eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null }) }) }),
          }),
        };
      }
      // destination_images_cache: cache read, rate-limit count, upsert.
      return {
        select: (_cols: string, opts?: { head?: boolean }) =>
          opts?.head
            ? { gte: async () => ({ count: 0 }) }
            : { eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) },
        upsert: () => ({}),
      };
    },
  }),
}));

const fetchMock = vi.fn(async () => ({
  ok: true,
  json: async () => ({ data: [{ url: "https://generated.example/hero.png" }] }),
}));

const BASE_CTX = {
  tenant_id: "t1",
  destination: "Ketchikan",
  cruise_line: "Norwegian Cruise Line",
  coordinator_url: null,
};

describe("AI_ELIGIBLE_TIERS codes are real (§3.3)", () => {
  it("every gate entry is a key of CODE_TO_TIER_MAP — a phantom code silently kills the feature", () => {
    for (const code of AI_ELIGIBLE_TIERS) {
      expect(Object.keys(CODE_TO_TIER_MAP), `"${code}" is not a real tier_definitions code`).toContain(code);
    }
  });

  it("gate covers exactly the pro + agency tiers of both tenant types", () => {
    const proAndAgency = Object.entries(CODE_TO_TIER_MAP)
      .filter(([, tier]) => tier === "pro" || tier === "agency")
      .map(([code]) => code);
    expect([...AI_ELIGIBLE_TIERS].sort()).toEqual(proAndAgency.sort());
  });
});

describe("selectHeroImage tier gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("IMAGE_GEN_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "test-key");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("a real pro-tier code (sub_pro) reaches AI generation", async () => {
    const url = await selectHeroImage({ ...BASE_CTX, tier: "sub_pro" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(url).toBe("https://generated.example/hero.png");
  });

  it("null tier (lookup failed / no tier) falls to the cruise-line default without generating", async () => {
    const url = await selectHeroImage({ ...BASE_CTX, tier: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(url).toContain("cruise-ship-ocean.jpg");
  });

  it("starter tiers never generate", async () => {
    const url = await selectHeroImage({ ...BASE_CTX, tier: "sub_starter" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(url).toContain("cruise-ship-ocean.jpg");
  });
});
