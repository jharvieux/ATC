// #902 / D-195 — PLATFORM HELP CONTEXT block for TA-mode chat.
//
// Grounds platform how-to answers in content/help/*.md via the in-process
// docs-loader — deliberately NOT the RAG service (12 docs; see the design
// doc's rejected-alternatives). Built ONLY on the chat route's TA branch,
// so customer-audience prompts structurally never contain help content.
//
// Scoring is token-based rather than reusing searchDocs(): that function
// substring-matches the WHOLE query (right for the help search box, but a
// conversational message like "how do I create a quote for a customer?"
// is never a verbatim substring of any doc).

import { loadAllDocs, type HelpDoc } from "@/lib/help-ai/docs-loader";

const MAX_DOCS = 2;
const MAX_DOC_CHARS = 3000;
// Qualification requires a TITLE hit: platform questions name the feature
// ("branding", "quote", "CRM", "billing"), while travel turns full of generic
// words ("some good Alaska sailings for a group") rack up body-only matches
// in every doc — body hits therefore only refine ranking, never qualify.
const TITLE_WEIGHT = 3;

const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "how", "what", "where", "when", "why",
  "can", "does", "with", "this", "that", "are", "was", "have", "has", "had",
  "from", "into", "about", "them", "they", "their", "our", "out", "not",
  "but", "all", "any", "get", "set", "use", "using", "way", "need", "want",
  "should", "would", "could", "please", "help", "there", "here", "its",
]);

function tokenize(message: string): string[] {
  return [...new Set(
    message
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  )];
}

function scoreDoc(doc: HelpDoc, tokens: string[]): { score: number; titleHits: number } {
  const title = doc.title.toLowerCase();
  const body = doc.body_markdown.toLowerCase();
  let score = 0;
  let titleHits = 0;
  for (const t of tokens) {
    if (title.includes(t)) {
      score += TITLE_WEIGHT;
      titleHits++;
    } else if (body.includes(t)) {
      score += 1;
    }
  }
  return { score, titleHits };
}

/**
 * Returns the PLATFORM HELP CONTEXT prompt block for a TA-mode turn, or null
 * when the message doesn't plausibly touch platform functionality (the
 * common case — travel questions skip the block entirely).
 *
 * `tierCode` filters tier-gated docs (a doc with no `tiers:` frontmatter is
 * universal) so a TA never reads instructions for features their plan lacks.
 */
export function buildHelpContextBlock(message: string, tierCode: string): string | null {
  const tokens = tokenize(message);
  if (tokens.length === 0) return null;

  const scored = loadAllDocs()
    .filter((d) => d.tiers.length === 0 || d.tiers.includes(tierCode))
    .map((doc) => ({ doc, ...scoreDoc(doc, tokens) }))
    .filter((s) => s.titleHits >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_DOCS);

  if (scored.length === 0) return null;

  const sections = scored.map(({ doc }) => {
    const body = doc.body_markdown.length > MAX_DOC_CHARS
      ? `${doc.body_markdown.slice(0, MAX_DOC_CHARS)}\n[…truncated — full doc: "${doc.title}" on the Help page]`
      : doc.body_markdown;
    return `--- Platform doc: ${doc.title} ---\n${body}`;
  });

  return [
    "PLATFORM HELP CONTEXT (how the AI Travel Concierge platform works):",
    "INSTRUCTIONS: Use this section ONLY for questions about the platform itself (settings, CRM, quotes, branding, billing, personas). Answer platform questions strictly from these docs. If a platform question isn't covered here, say the documentation doesn't cover it and point them to the Help page — never invent platform features or behavior. Ignore this section entirely for travel questions.",
    ...sections,
  ].join("\n\n");
}
