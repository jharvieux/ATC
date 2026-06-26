// #902 / D-195 — the customer-prompt-unchanged invariant and the TA Layer-2
// swap. The contract: adding the audience dimension must be invisible to every
// existing caller (default "customer" → byte-identical prompt AND cacheKey),
// while audience="tenant_member" swaps the editable safety block for
// TA_MEMBER_RULES, skips the tenant addendum, and carries the help block.

import { describe, it, expect, vi, beforeEach } from "vitest";

const EDITABLE_SENTINEL = "EDITABLE_SAFETY_SENTINEL — booking commitments for customers";
const ADDENDUM_CONTENT = "We are Reef & Rum Travel, island specialists.";

vi.mock("@/lib/personas/persona-repository", () => ({
  getPersonaForPrompt: vi.fn(async () => ({
    version: 7,
    persona: {
      slug: "marcus-cole",
      kind: "travel_concierge",
      display_name: "Marcus Cole",
      tagline: "Caribbean expert",
      specialty: "Caribbean & Latin America",
      background: "You are Marcus Cole, a Caribbean cruise specialist.",
      voice: "Warm, direct.",
      tone_style: "Conversational.",
      expertise_primary: "Caribbean itineraries",
      expertise_secondary: "Latin America",
      expertise_fallback_note: null,
      anti_instructions: ["Never invent prices."],
      disclosure_pattern: "I'm Marcus, your AI cruise concierge.",
      prompt_body: "PERSONA BODY: island-chain matching knowledge.",
      tone_calibration_placeholder: "{{TONE_CALIBRATION}}",
    },
  })),
  getSafetyConfig: vi.fn(async () => ({ editable_block: EDITABLE_SENTINEL, version: 4 })),
}));

import { buildSystemPrompt } from "@/lib/personas/build-system-prompt";
import { TA_MEMBER_RULES, LEGAL_KERNEL } from "@/lib/personas/platform-constraints";
import { getSafetyConfig } from "@/lib/personas/persona-repository";
import type { SupabaseClient } from "@supabase/supabase-js";

// Fluent DB stub: persona_addendums returns an approved addendum so the test
// can prove TA mode SKIPS it even when one exists.
function dbStub(): { db: SupabaseClient; fromCalls: string[] } {
  const fromCalls: string[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) chain[m] = () => chain;
  chain.maybeSingle = async () => ({
    data: { content: ADDENDUM_CONTENT, updated_at: "2026-06-01T00:00:00Z", status: "approved" },
    error: null,
  });
  const db = {
    from: (t: string) => {
      fromCalls.push(t);
      return chain;
    },
  } as unknown as SupabaseClient;
  return { db, fromCalls };
}

const baseOpts = (db: SupabaseClient) => ({
  persona_slug: "marcus-cole",
  tenant_id: "tenant-1",
  tenant_tier: "byo_agency", // addendum-eligible tier — makes the TA skip observable
  tone_level: 2,
  db,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildSystemPrompt audience dimension (#902)", () => {
  it("customer invariance: omitted audience === explicit 'customer', prompt and cacheKey byte-identical", async () => {
    const a = await buildSystemPrompt(baseOpts(dbStub().db));
    const b = await buildSystemPrompt({ ...baseOpts(dbStub().db), audience: "customer" });
    expect(b.prompt).toBe(a.prompt);
    expect(b.cacheKey).toBe(a.cacheKey);
    // And the customer prompt is what it always was: editable safety + addendum, no TA register.
    expect(a.prompt).toContain(EDITABLE_SENTINEL);
    expect(a.prompt).toContain(ADDENDUM_CONTENT);
    expect(a.prompt).not.toContain("TA mode");
  });

  it("appends a CURRENT DATE block with the Northern-Hemisphere season convention (live date/season bug)", async () => {
    // Two live bugs this pins: (1) the model guessed a past year for "next spring"
    // with no date anchor; (2) it assumed the destination's (Southern-Hemisphere)
    // season for Australia. The prompt must carry today's date and the convention.
    const { prompt } = await buildSystemPrompt(baseOpts(dbStub().db));
    const today = new Date().toISOString().slice(0, 10);
    expect(prompt).toContain(`CURRENT DATE: ${today}`);
    expect(prompt).toMatch(/Northern-Hemisphere/i);
    expect(prompt).toMatch(/do not assume a Southern-Hemisphere season for an Australia/i);
    expect(prompt).toMatch(/Never propose or ask about dates that are already in the past/i);
  });

  it("tenant_member: TA rules replace the editable safety block; legal kernel survives", async () => {
    const { prompt } = await buildSystemPrompt({ ...baseOpts(dbStub().db), audience: "tenant_member" });
    expect(prompt).toContain(TA_MEMBER_RULES);
    expect(prompt).toContain(LEGAL_KERNEL); // AI disclosure applies in both registers
    expect(prompt).not.toContain(EDITABLE_SENTINEL);
    // Layer 1 persona identity is untouched.
    expect(prompt).toContain("PERSONA BODY: island-chain matching knowledge.");
    // The customer-audience safety config is not even read in TA mode.
    expect(getSafetyConfig).not.toHaveBeenCalled();
  });

  it("tenant_member: tenant addendum skipped even when approved + tier-eligible (it's customer positioning)", async () => {
    const { db, fromCalls } = dbStub();
    const { prompt } = await buildSystemPrompt({ ...baseOpts(db), audience: "tenant_member" });
    expect(prompt).not.toContain(ADDENDUM_CONTENT);
    expect(fromCalls).not.toContain("persona_addendums");
  });

  it("tenant_member: help_context_block lands in the prompt; cacheKey carries the audience suffix", async () => {
    const block = "PLATFORM HELP CONTEXT (how the AI Travel Concierge platform works):\n--- Platform doc: Branding ---";
    const { prompt, cacheKey } = await buildSystemPrompt({
      ...baseOpts(dbStub().db),
      audience: "tenant_member",
      help_context_block: block,
    });
    expect(prompt).toContain(block);
    expect(cacheKey).toContain(":aud=ta");
  });

  it("customer cacheKey has no audience suffix (prompt-cache continuity for the existing cohort)", async () => {
    const { cacheKey } = await buildSystemPrompt(baseOpts(dbStub().db));
    expect(cacheKey).not.toContain("aud=");
  });
});
