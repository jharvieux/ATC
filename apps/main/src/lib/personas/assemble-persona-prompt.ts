// §9.3 — Deterministic Layer-1 persona prompt assembly.
//
// A persona is stored (personas table / persona-defaults.ts) as structured
// fields PLUS a freeform prose body. This module assembles those into the
// Layer-1 system prompt. Every field feeds the output — there are no
// decorative fields (D-091 no-stub-shaped-code): editing `voice`,
// `expertise_primary`, an `anti_instruction`, or `prompt_body` all change the
// generated prompt. The output is a pure function of the input, so a snapshot
// test can pin each persona's assembled prompt.
//
// Two shapes, branched on the real `kind` discriminator (both reachable):
//   - travel_concierge: identity + personality + focus + body + boundaries
//   - platform_help:    the prose body verbatim. Help AI (§32.4.2) is
//                       self-contained and has no travel-persona fields; its
//                       body already carries role/capabilities/boundaries and
//                       an inline {{TONE_CALIBRATION}} marker.

export const PERSONA_KIND_TRAVEL = "travel_concierge";
export const PERSONA_KIND_PLATFORM_HELP = "platform_help";

export type PersonaRecord = {
  slug: string;
  kind: string;
  display_name: string;
  tagline: string | null;
  specialty: string | null;
  // 2nd-person identity paragraph (empty for platform_help).
  background: string;
  voice: string | null;
  tone_style: string | null;
  expertise_primary: string | null;
  expertise_secondary: string | null;
  expertise_fallback_note: string | null;
  anti_instructions: string[];
  disclosure_pattern: string | null;
  // Freeform admin-editable prose — the bulk of the domain knowledge.
  prompt_body: string;
  tone_calibration_placeholder: string;
};

export function assemblePersonaPrompt(p: PersonaRecord): string {
  if (p.kind === PERSONA_KIND_PLATFORM_HELP) {
    // Self-contained; the {{TONE_CALIBRATION}} marker inside the body is
    // substituted downstream by build-system-prompt.
    return p.prompt_body.trim();
  }

  const sections: string[] = [p.background.trim()];

  // Terse structured style descriptor. Intentionally coexists with any
  // richer personality/philosophy prose inside prompt_body — header is
  // "VOICE & TONE" (not "YOUR PERSONALITY") so it never collides with a
  // persona body that leads with its own "YOUR PERSONALITY:" section.
  const personality = [p.voice, p.tone_style].filter((s): s is string => !!s);
  if (personality.length > 0) {
    sections.push(`VOICE & TONE:\n${personality.join("\n")}`);
  }

  const focus: string[] = [];
  if (p.expertise_primary) focus.push(`- Primary: ${p.expertise_primary}`);
  if (p.expertise_secondary) focus.push(`- Also: ${p.expertise_secondary}`);
  if (p.expertise_fallback_note) focus.push(`- ${p.expertise_fallback_note}`);
  if (focus.length > 0) {
    sections.push(`YOUR AREAS OF FOCUS:\n${focus.join("\n")}`);
  }

  sections.push(p.prompt_body.trim());

  if (p.anti_instructions.length > 0) {
    const bullets = p.anti_instructions.map((a) => `- ${a}`).join("\n");
    sections.push(`YOUR BOUNDARIES (these always apply):\n${bullets}`);
  }

  // Placeholder substituted by build-system-prompt's tone-calibration step.
  sections.push(p.tone_calibration_placeholder);

  return sections.join("\n\n");
}
