// BP36 §33.5 / §26.8 — minimal prompt-injection screen for scraped text.
//
// Scraped content is untrusted input. RAG chunk text is consumed strictly
// as data, never as instructions, so the model-side framing already
// protects us. This screen adds defense-in-depth: any text containing
// obvious imperative-toward-the-model phrases or system-prompt-like
// fragments is rejected before it ever reaches the embedding step.
//
// Conservative on the false-positive side — we'd rather quarantine a
// few legit ship-spec pages than ingest a poisoned one. The Inngest job
// counts quarantines separately so operator can review patterns.

const SUSPICIOUS_PATTERNS: RegExp[] = [
  /ignore (all|any|the) (previous|prior|above) (instructions?|prompts?)/i,
  /disregard (all|any|the) (previous|prior|above) (instructions?|prompts?)/i,
  /you are (now |actually )?(a different|another) (ai|assistant|model|chatbot)/i,
  /\bsystem\s*[:>]/i,
  /\bassistant\s*[:>]/i,
  /<\s*system\s*>/i,
  /<\s*\/?\s*(prompt|instructions?)\s*>/i,
  /\bsudo\s+(rm|chmod|cat)/i,
  /execute (the )?(following|next) (code|command|instructions?)/i,
];

export interface InjectionScreenResult {
  ok: boolean;
  matchedPattern?: string;
}

export function screenForPromptInjection(text: string): InjectionScreenResult {
  for (const re of SUSPICIOUS_PATTERNS) {
    if (re.test(text)) {
      return { ok: false, matchedPattern: re.toString() };
    }
  }
  return { ok: true };
}
