// BP31 §32.4 — Help AI persona registration test.
//
// Pins:
//   - The Help AI persona is reachable via buildSystemPrompt with slug 'help_ai'
//   - Tenant addendum is NOT applied even on an agency-tier tenant with an
//     approved addendum row (§32.4.1)
//   - The prompt body contains the §32.4.2 role / capabilities / boundaries text

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildSystemPrompt } from "@/lib/personas/build-system-prompt";

function mockDb(addendumRow?: { content: string; updated_at: string; status: string }) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: addendumRow ?? null }),
            }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("Help AI persona (§32.4)", () => {
  it("is registered under slug 'help_ai' and renders without error", async () => {
    const result = await buildSystemPrompt({
      persona_slug: "help_ai",
      tenant_id: "tenant-1",
      tenant_tier: "sub_pro",
      db: mockDb(),
    });
    expect(result.prompt.length).toBeGreaterThan(100);
    expect(result.cacheKey).toContain("persona:help_ai");
  });

  it("includes the §32.4.2 role + capability + boundary phrases", async () => {
    const result = await buildSystemPrompt({
      persona_slug: "help_ai",
      tenant_id: "tenant-1",
      tenant_tier: "sub_pro",
      db: mockDb(),
    });
    expect(result.prompt).toMatch(/help assistant for the AI Travel Concierge platform/i);
    expect(result.prompt).toMatch(/search platform documentation/i);
    expect(result.prompt).toMatch(/do not invent feature behaviors/i);
    expect(result.prompt).toMatch(/REDACTED-NAME/);
  });

  it("does NOT apply the tenant addendum even on an agency-tier tenant with an approved row", async () => {
    const ADDENDUM_TEXT = "TENANT-SPECIFIC OVERRIDE — should never appear in Help AI prompt";
    const result = await buildSystemPrompt({
      persona_slug: "help_ai",
      tenant_id: "tenant-1",
      tenant_tier: "byo_agency",
      db: mockDb({ content: ADDENDUM_TEXT, updated_at: "2026-05-23T00:00:00Z", status: "approved" }),
    });
    expect(result.prompt).not.toContain(ADDENDUM_TEXT);
    expect(result.prompt).not.toContain("BEGIN TENANT ADDENDUM");
  });

  it("regular travel-concierge persona STILL applies addendum on agency tier (regression guard)", async () => {
    const ADDENDUM_TEXT = "Tenant Marcus addendum content";
    const result = await buildSystemPrompt({
      persona_slug: "marcus-cole",
      tenant_id: "tenant-1",
      tenant_tier: "byo_agency",
      db: mockDb({ content: ADDENDUM_TEXT, updated_at: "2026-05-23T00:00:00Z", status: "approved" }),
    });
    expect(result.prompt).toContain(ADDENDUM_TEXT);
    expect(result.prompt).toContain("BEGIN TENANT ADDENDUM");
  });
});
