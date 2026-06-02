// Pins the deterministic Layer-1 assembly for every seeded persona (§9.3).
//
// Two jobs:
//   1. Snapshot each assembled default prompt so any drift in the assembler or a
//      base-block is caught in review.
//   2. Encode the D-091 "no stub-shaped code" contract: every structured field
//      must feed the output. The field-presence and field-mutation tests fail if
//      a column ever stops affecting the generated prompt.

import { describe, it, expect } from "vitest";
import {
  assemblePersonaPrompt,
  PERSONA_KIND_PLATFORM_HELP,
  PERSONA_KIND_TRAVEL,
  type PersonaRecord,
} from "@/lib/personas/assemble-persona-prompt";
import { PERSONA_DEFAULTS, getPersonaDefault } from "@/lib/personas/persona-defaults";

function defaultFor(slug: string): PersonaRecord {
  const persona = getPersonaDefault(slug);
  if (!persona) throw new Error(`no default persona seeded for ${slug}`);
  return persona;
}

const travelDefaults = PERSONA_DEFAULTS.filter((p) => p.kind === PERSONA_KIND_TRAVEL);

describe("assemblePersonaPrompt — seeded defaults", () => {
  it("seeds 7 personas: 6 travel_concierge + 1 platform_help", () => {
    expect(PERSONA_DEFAULTS).toHaveLength(7);
    expect(travelDefaults).toHaveLength(6);
    expect(PERSONA_DEFAULTS.filter((p) => p.kind === PERSONA_KIND_PLATFORM_HELP)).toHaveLength(1);
  });

  describe.each(PERSONA_DEFAULTS)("persona: $slug", (persona) => {
    it("pins the assembled prompt", () => {
      expect(assemblePersonaPrompt(persona)).toMatchSnapshot();
    });
  });
});

describe("travel personas — every structured field feeds the output (D-091 no-stub)", () => {
  describe.each(travelDefaults)("persona: $slug", (persona) => {
    it("includes the 2nd-person background verbatim", () => {
      expect(assemblePersonaPrompt(persona)).toContain(persona.background.trim());
    });

    it("includes voice and tone under VOICE & TONE", () => {
      const prompt = assemblePersonaPrompt(persona);
      expect(prompt).toContain("VOICE & TONE:");
      if (persona.voice) expect(prompt).toContain(persona.voice);
      if (persona.tone_style) expect(prompt).toContain(persona.tone_style);
    });

    it("includes primary and secondary expertise under AREAS OF FOCUS", () => {
      const prompt = assemblePersonaPrompt(persona);
      expect(prompt).toContain("YOUR AREAS OF FOCUS:");
      if (persona.expertise_primary) expect(prompt).toContain(persona.expertise_primary);
      if (persona.expertise_secondary) expect(prompt).toContain(persona.expertise_secondary);
    });

    it("includes the freeform prompt_body verbatim", () => {
      expect(assemblePersonaPrompt(persona)).toContain(persona.prompt_body.trim());
    });

    it("lists every anti-instruction under BOUNDARIES", () => {
      const prompt = assemblePersonaPrompt(persona);
      expect(prompt).toContain("YOUR BOUNDARIES (these always apply):");
      for (const anti of persona.anti_instructions) {
        expect(prompt).toContain(anti);
      }
    });

    it("ends with the tone-calibration placeholder for downstream substitution", () => {
      expect(assemblePersonaPrompt(persona).endsWith(persona.tone_calibration_placeholder)).toBe(
        true,
      );
    });
  });

  it("marcus surfaces the CATCHALL expertise_fallback_note", () => {
    const marcus = defaultFor("marcus-cole");
    expect(marcus.expertise_fallback_note).toBeTruthy();
    expect(assemblePersonaPrompt(marcus)).toContain(marcus.expertise_fallback_note as string);
  });
});

describe("mutating a field changes the assembled prompt (D-091 no-stub)", () => {
  const base = defaultFor("marcus-cole");

  it("editing voice changes output and surfaces the new text", () => {
    const before = assemblePersonaPrompt(base);
    const after = assemblePersonaPrompt({ ...base, voice: "ENTIRELY NEW VOICE" });
    expect(after).not.toEqual(before);
    expect(after).toContain("ENTIRELY NEW VOICE");
  });

  it("editing prompt_body changes output", () => {
    const after = assemblePersonaPrompt({ ...base, prompt_body: "ENTIRELY NEW BODY" });
    expect(after).toContain("ENTIRELY NEW BODY");
    expect(after).not.toContain(base.prompt_body.trim());
  });

  it("removing an anti-instruction removes its boundary line", () => {
    const [dropped, ...rest] = base.anti_instructions;
    const after = assemblePersonaPrompt({ ...base, anti_instructions: rest });
    expect(after).not.toContain(dropped);
  });

  it("clearing all anti-instructions drops the BOUNDARIES section", () => {
    const after = assemblePersonaPrompt({ ...base, anti_instructions: [] });
    expect(after).not.toContain("YOUR BOUNDARIES (these always apply):");
  });
});

describe("help_ai (platform_help) is self-contained", () => {
  const help = defaultFor("help_ai");

  it("returns the trimmed prompt_body verbatim — no assembled sections", () => {
    expect(assemblePersonaPrompt(help)).toEqual(help.prompt_body.trim());
  });

  it("injects none of the travel section headers", () => {
    const prompt = assemblePersonaPrompt(help);
    expect(prompt).not.toContain("VOICE & TONE:");
    expect(prompt).not.toContain("YOUR AREAS OF FOCUS:");
    expect(prompt).not.toContain("YOUR BOUNDARIES (these always apply):");
  });

  it("retains the inline {{TONE_CALIBRATION}} marker for downstream substitution", () => {
    expect(assemblePersonaPrompt(help)).toContain("{{TONE_CALIBRATION}}");
  });
});
