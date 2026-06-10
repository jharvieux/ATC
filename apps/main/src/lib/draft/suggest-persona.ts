// #904 / D-193 decision 4 — suggest the best-fit persona for an inquiry.
//
// Deliberate deviation from the issue's "Haiku-class call" sketch: this is a
// deterministic keyword scorer over the existing AGENT_CATALOG quizTags +
// specialty terms. D-193's product decision only requires "cheap
// classification" with the TA confirming — and per CLAUDE.md, if code can
// answer, code answers (zero cost, zero latency, testable). The signature
// stays model-upgradeable if real-world routing disappoints.

import { AGENT_CATALOG } from "@/lib/agents/catalog";

// Tag → extra trigger words the tag itself doesn't literally contain.
const TAG_SYNONYMS: Record<string, string[]> = {
  caribbean: ["bahamas", "aruba", "cozumel", "jamaica", "barbados", "antigua"],
  warm: [],
  beach: ["island", "islands", "snorkel", "snorkeling"],
  mediterranean: ["greece", "greek", "italy", "croatia", "barcelona", "adriatic", "santorini"],
  europe: ["european"],
  river: ["rhine", "danube", "douro", "viking"],
  food: ["culinary", "dining", "restaurants"],
  history: [],
  luxury: ["regent", "silversea", "seabourn", "explora", "ultra-premium", "suite", "butler"],
  premium: [],
  "small-ship": ["yacht"],
  world: ["world cruise"],
  alaska: ["glacier", "glaciers", "juneau", "ketchikan", "inside passage"],
  adventure: ["expedition", "antarctica", "iceland", "fjord", "fjords", "norway"],
  expedition: [],
  cold: [],
  wildlife: ["whales", "bears"],
  accessible: ["wheelchair", "mobility", "accessibility", "ada", "disability"],
  mobility: ["scooter"],
  inclusive: ["autism", "sensory", "dietary"],
  family: ["kids", "children", "child", "toddler", "teens", "tween", "tweens"],
  kids: [],
  multigen: ["multigenerational", "grandparents", "grandkids"],
  disney: ["royal caribbean", "carnival"],
};

export interface PersonaSuggestion {
  slug: string;
  name: string;
  specialty: string;
}

// A suggestion needs at least two distinct term hits — one shared word like
// "family" alone shouldn't steer the TA. No suggestion beats a wrong one.
const MIN_HITS = 2;

export function suggestPersona(inquiry: string): PersonaSuggestion | null {
  const text = inquiry.toLowerCase();
  if (!text.trim()) return null;

  let best: { slug: string; name: string; specialty: string; hits: number } | null = null;

  for (const agent of AGENT_CATALOG) {
    const terms = new Set<string>();
    for (const tag of agent.quizTags) {
      terms.add(tag.toLowerCase());
      for (const syn of TAG_SYNONYMS[tag] ?? []) terms.add(syn);
    }
    for (const word of agent.specialty.toLowerCase().split(/[^a-z]+/)) {
      if (word.length >= 4) terms.add(word);
    }

    let hits = 0;
    for (const term of terms) {
      if (term && text.includes(term)) hits++;
    }
    if (hits >= MIN_HITS && (!best || hits > best.hits)) {
      best = { slug: agent.slug, name: agent.name, specialty: agent.specialty, hits };
    }
  }

  return best ? { slug: best.slug, name: best.name, specialty: best.specialty } : null;
}
