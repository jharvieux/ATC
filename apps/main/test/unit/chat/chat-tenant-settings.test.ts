// #1586 — request-scoped tenant_settings loader.
//
// WHY: consolidating the chat route's two tenant_settings reads into one must
// preserve the exact defaults the inline reads applied (tone cap 3, profanity
// false) when the row is missing — otherwise a tenant with no settings row
// would silently change tone/profanity behavior.

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadChatTenantSettings, deriveChatTenantFlags } from "@/lib/chat/chat-tenant-settings";
import type { CachedTenantSnapshot } from "@/lib/abuse/snapshot";

function snap(over: Partial<CachedTenantSnapshot>): CachedTenantSnapshot {
  return {
    tenant: { tenant_id: "t1", tier_code: "sub_pro", seat_count: 1, billing_period: "monthly" },
    ai_cost_state: "ok",
    is_sandbox: false,
    ai_paused_by_platform: false,
    fetched_at: Date.now(),
    ...over,
  };
}

function makeDb(data: unknown): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data, error: null }) }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("loadChatTenantSettings", () => {
  it("returns the row's tone cap + profanity flag", async () => {
    const s = await loadChatTenantSettings(
      makeDb({ persona_tone_max_level: 5, allow_profanity: true }),
      "t1",
    );
    expect(s.personaToneMaxLevel).toBe(5);
    expect(s.allowProfanity).toBe(true);
  });

  it("applies defaults (tone 3, profanity false) when the row is missing", async () => {
    const s = await loadChatTenantSettings(makeDb(null), "t1");
    expect(s.personaToneMaxLevel).toBe(3);
    expect(s.allowProfanity).toBe(false);
  });

  it("fires onDbRead once (the single consolidated read)", async () => {
    let reads = 0;
    await loadChatTenantSettings(makeDb(null), "t1", () => { reads += 1; });
    expect(reads).toBe(1);
  });
});

describe("deriveChatTenantFlags — fail-closed/fail-open defaults", () => {
  it("maps a real snapshot straight through", () => {
    const f = deriveChatTenantFlags(snap({ tenant: { tenant_id: "t1", tier_code: "sub_agency", seat_count: 1, billing_period: "monthly" }, is_sandbox: true, ai_paused_by_platform: true }));
    expect(f.tenantTier).toBe("sub_agency");
    expect(f.isSandbox).toBe(true);
    expect(f.aiPausedByPlatform).toBe(true);
  });

  it("FAIL-CLOSED: a null snapshot (load failure) stamps isSandbox=true", () => {
    // WHY: mislabeling a sandbox conversation as real corrupts the abuse
    // firewall (not recoverable). A snapshot-load failure must bias to test.
    const f = deriveChatTenantFlags(null);
    expect(f.isSandbox).toBe(true);
  });

  it("FAIL-OPEN: a null snapshot does NOT pause the tenant", () => {
    // WHY: a transient tenants-read blip must not take a healthy tenant's AI
    // offline; the durable per-tenant pause lever is a deliberate admin action.
    const f = deriveChatTenantFlags(null);
    expect(f.aiPausedByPlatform).toBe(false);
    expect(f.tenantTier).toBe("byo_research");
  });

  it("a genuine not-found tenant (stub, is_sandbox=false) is NOT stamped test", () => {
    const f = deriveChatTenantFlags(snap({ tenant: { tenant_id: "t1", tier_code: "byo_research", seat_count: 1, billing_period: "monthly" }, is_sandbox: false }));
    expect(f.isSandbox).toBe(false);
  });
});
