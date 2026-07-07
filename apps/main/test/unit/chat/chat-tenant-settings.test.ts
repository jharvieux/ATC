// #1586 — request-scoped tenant_settings loader.
//
// WHY: consolidating the chat route's two tenant_settings reads into one must
// preserve the exact defaults the inline reads applied (tone cap 3, profanity
// false) when the row is missing — otherwise a tenant with no settings row
// would silently change tone/profanity behavior.

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadChatTenantSettings } from "@/lib/chat/chat-tenant-settings";

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
