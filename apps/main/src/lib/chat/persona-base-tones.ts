// §24.5 — Per-persona base tone-level inclination.
//
// The spec hints "Marcus more casual; Priya more polished". We map each
// persona slug to a base level on the 1-5 scale (1=formal, 5=matched energy).
// The map is the single source of truth — kept here rather than on each
// persona base block to avoid churning persona files (D-045 personas live in code).

const DEFAULT_BASE_TONE_LEVEL = 2;

const PERSONA_BASE_TONE: Record<string, number> = {
  "marcus-cole":    3, // Conversational, warm, direct
  "marco-bellini":  3, // Passionate, opinionated, culturally obsessed
  "maya-patel":     2, // Warm, practical, clinical precision
  "jenny-hartwell": 3, // Warm, practical, honest parenting logistics
  "priya-sharma":   2, // Refined, comparison-focused, never oversells
  "captain-dave":   3, // Direct, factual, gently funny
};

export function basePersonaTone(slug: string | null | undefined): number {
  if (!slug) return DEFAULT_BASE_TONE_LEVEL;
  return PERSONA_BASE_TONE[slug] ?? DEFAULT_BASE_TONE_LEVEL;
}
