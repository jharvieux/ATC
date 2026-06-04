// Find-my-agent quiz logic. Pure: takes the user's selected tags from
// the quiz form, sums per-agent matches against AGENT_CATALOG.quizTags,
// returns the highest-scoring agent slug (with a deterministic
// tiebreaker — catalog order — so identical scores resolve the same way
// across reloads).

import { AGENT_CATALOG } from "./catalog";

export interface QuizQuestion {
  id: string;
  prompt: string;
  options: Array<{ label: string; tags: string[] }>;
}

/**
 * Question set v1. Each option carries the tags it contributes when
 * selected. Tags map onto AGENT_CATALOG.quizTags (see catalog.ts).
 */
export const QUIZ_QUESTIONS: readonly QuizQuestion[] = [
  {
    id: "destination",
    prompt: "Where do you want to cruise?",
    options: [
      { label: "Caribbean / Bahamas", tags: ["caribbean", "warm", "beach"] },
      { label: "Mediterranean / Europe", tags: ["mediterranean", "europe", "history"] },
      { label: "Alaska / cold-water", tags: ["alaska", "cold", "wildlife"] },
      { label: "I'm flexible", tags: [] },
    ],
  },
  {
    id: "style",
    prompt: "What kind of trip?",
    options: [
      { label: "Adventure / expedition", tags: ["adventure", "expedition"] },
      { label: "Relax on the water", tags: ["beach", "warm"] },
      { label: "Food, culture, ports", tags: ["food", "history", "river"] },
      { label: "Family fun", tags: ["family", "kids"] },
    ],
  },
  {
    id: "priority",
    prompt: "What matters most?",
    options: [
      { label: "Luxury accommodation", tags: ["luxury", "premium", "small-ship"] },
      { label: "Accessibility", tags: ["accessible", "mobility", "inclusive"] },
      { label: "Wildlife / nature", tags: ["wildlife", "expedition"] },
      { label: "World variety", tags: ["world", "river"] },
    ],
  },
  {
    id: "party",
    prompt: "Who's traveling with you?",
    options: [
      { label: "Just adults", tags: [] },
      { label: "Bringing the kids", tags: ["family", "kids", "disney"] },
      { label: "Someone needs accommodations", tags: ["accessible", "mobility"] },
      { label: "Multi-generational group", tags: ["multigen", "family"] },
    ],
  },
];

/**
 * Score each agent against the set of selected tags. Returns the winning
 * slug. Ties resolve to whichever winner appears first in AGENT_CATALOG
 * (deterministic — same input always returns the same agent).
 */
export function pickAgentFromTags(selected: string[]): string {
  const tally = new Map<string, number>();
  for (const agent of AGENT_CATALOG) {
    let score = 0;
    for (const tag of selected) {
      if (agent.quizTags.includes(tag)) score += 1;
    }
    tally.set(agent.slug, score);
  }
  let winnerSlug = AGENT_CATALOG[0]!.slug;
  let winnerScore = -1;
  // Iterate in catalog order so a tie returns the earlier entry.
  for (const agent of AGENT_CATALOG) {
    const score = tally.get(agent.slug) ?? 0;
    if (score > winnerScore) {
      winnerScore = score;
      winnerSlug = agent.slug;
    }
  }
  return winnerSlug;
}
