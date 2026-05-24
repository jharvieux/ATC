// BP24 — Per-sentence supervisor check for streaming chat (option B UX).
//
// Runs on every sentence yielded by bufferToSentences during a streamed
// model response. Deliberately narrow scope: ONLY the deterministic
// deny-list lexical check, because:
//
//   • It's the only supervisor check that can give a deterministic verdict
//     on a single sentence (other checks like grounding, persona drift,
//     and asset_id validation need the assembled response).
//   • It's the highest-severity check we have — a hit auto-escalates after
//     3 consecutive failures (§24.5 / §10.2). Catching it mid-sentence
//     stops bad output reaching the user faster than today's post-hoc path.
//   • It's cheap (regex with word boundaries; no network).
//
// All other supervisor checks continue to run via runSupervisor() on the
// assembled response after the stream completes — see chat/route.ts.

import { findLexicalMatch, hashTerm } from "./checks/tone-drift";

export interface PerSentenceCheckResult {
  hit: boolean;
  // Hashed only — never expose the raw term, matching the §24.5 audit rule.
  hashedTerm?: string;
}

export function checkSentence(
  sentence: string,
  denyList: string[],
): PerSentenceCheckResult {
  const match = findLexicalMatch(sentence, denyList);
  if (match) return { hit: true, hashedTerm: hashTerm(match) };
  return { hit: false };
}
