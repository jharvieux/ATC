// #444 — getTenantTierCode embed-shape handling.
//
// WHY: supabase-js forward-FK embeds may come back as an object OR an array
// (D-265) depending on how PostgREST resolves the relationship. The helper
// must unwrap both, and return null (least privilege — no tier-gated
// features) when the tenant is missing or has no tier.

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTenantTierCode } from "@/lib/tenancy/get-tenant-tier-code";

function dbReturning(data: unknown): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data, error: null }) }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("getTenantTierCode", () => {
  it("unwraps an object-shaped embed", async () => {
    const code = await getTenantTierCode(dbReturning({ tier_definitions: { code: "sub_pro" } }), "t1");
    expect(code).toBe("sub_pro");
  });

  it("unwraps an array-shaped embed (D-265)", async () => {
    const code = await getTenantTierCode(dbReturning({ tier_definitions: [{ code: "byo_agency" }] }), "t1");
    expect(code).toBe("byo_agency");
  });

  it("returns null when the tenant row is missing", async () => {
    expect(await getTenantTierCode(dbReturning(null), "t1")).toBeNull();
  });

  it("returns null for an empty array embed", async () => {
    expect(await getTenantTierCode(dbReturning({ tier_definitions: [] }), "t1")).toBeNull();
  });
});
