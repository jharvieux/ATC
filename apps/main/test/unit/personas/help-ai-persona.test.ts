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
import { getPersonaDefault } from "@/lib/personas/persona-defaults";
import { SAFETY_EDITABLE_DEFAULT } from "@/lib/personas/platform-constraints";

// Table-aware mock: buildSystemPrompt now reads personas (Layer 1) and
// persona_safety_config (Layer 2) from the DB (D-138) in addition to the
// persona_addendums (Layer 3) read this test exercises. The personas rows are
// derived from the code defaults so the seeded content matches what an admin
// would see/edit, exercising the real DB path rather than the fallback.
function mockDb(addendumRow?: { content: string; updated_at: string; status: string }) {
  return {
    from: (table: string) => {
      if (table === "personas") {
        return {
          select: () => ({
            eq: (_col: string, slug: string) => ({
              maybeSingle: async () => {
                const def = getPersonaDefault(slug);
                return { data: def ? { ...def, version: 1 } : null, error: null };
              },
            }),
          }),
        };
      }
      if (table === "persona_safety_config") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { editable_block: SAFETY_EDITABLE_DEFAULT, version: 1 },
                error: null,
              }),
            }),
          }),
        };
      }
      // persona_addendums (Layer 3): three eq() filters then maybeSingle.
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: addendumRow ?? null, error: null }),
              }),
            }),
          }),
        }),
      };
    },
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
