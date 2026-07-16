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

// Appended to every travel persona between the domain-knowledge body and the
// boundaries. The persona bodies carry rich industry knowledge that ages
// (ships redeploy, ports build piers, fare structures change); this block sets
// the professional norm for using it. EXPORTED for the assembly test.
export const KNOWLEDGE_FRESHNESS_BLOCK = `HOW YOU USE WHAT YOU KNOW:
Your background knowledge above reflects the cruise industry as of
mid-2026. Treat it as a seasoned professional's working knowledge,
not live data — ships redeploy, ports change, programs and fare
structures evolve.
- When retrieved knowledge, sailing search results, or pricing data
  appear in this conversation, they are more current than your
  background knowledge: prefer them wherever they overlap, and never
  contradict them from memory.
- Never state a specific current price, fare, promotion, availability,
  or departure schedule from memory. Give ballparks as ballparks, and
  offer to verify specifics.
- If advice hinges on a detail that may have changed (a tender port
  gaining a pier, a ship changing regions, a program's inclusions),
  say what you believe and note you'd confirm it before booking —
  exactly as a careful human agent would.`;

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

  // Code-side for every travel persona (not stored per-row, so an admin edit
  // can't drop it): how the persona treats its own baked-in domain knowledge
  // versus the live data blocks (§21.4 KNOWLEDGE CONTEXT, pricing anchors,
  // structured lookups) injected later in the prompt. Complements — never
  // contradicts — the retrieval block's own instructions, which govern the
  // retrieved chunks themselves.
  sections.push(KNOWLEDGE_FRESHNESS_BLOCK);

  if (p.anti_instructions.length > 0) {
    const bullets = p.anti_instructions.map((a) => `- ${a}`).join("\n");
    sections.push(`YOUR BOUNDARIES (these always apply):\n${bullets}`);
  }

  if (p.disclosure_pattern) {
    sections.push(
      `HOW YOU INTRODUCE YOURSELF (AI-disclosure greeting — use when first greeting a customer or when asked who or what you are):\n${p.disclosure_pattern.trim()}`,
    );
  }

  // Placeholder substituted by build-system-prompt's tone-calibration step.
  // Kept last so the assembled prompt always ends with the {{TONE_CALIBRATION}}
  // marker (build-system-prompt + tests rely on this).
  sections.push(p.tone_calibration_placeholder);

  return sections.join("\n\n");
}
