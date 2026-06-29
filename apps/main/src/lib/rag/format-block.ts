// §21.4 — KNOWLEDGE CONTEXT block formatting.
//
// Returns a single string ready for injection into the persona system prompt.
// Caller injects this AFTER the persona base block and platform constraints,
// BEFORE customer context.
//
// The format is consumed by Layer-1 persona-prompt instructions (§21.10) —
// the persona is trained to read the per-chunk metadata to decide which
// chunks to cite, hedge on, or ignore.
//
// Citation contract (§21.5): the persona cites in prose; the chunk IDs
// returned alongside the block are used to render the click-to-expand UI
// (Task 7 — <MessageSources/>).

import type { RetrievedChunk } from "./chunk-types";

export interface FormatBlockOpts {
  // Per-category half-lives in days (from platform_settings.category_halflives_days).
  // If a chunk's category has a half-life and its age exceeds it, prepend
  // "may be outdated" marker per §21.7.
  categoryHalflives?: Record<string, number>;
  now?: Date;
  // When a structured sailing/itinerary lookup was attempted but returned no
  // results, pass a human-readable description of what was searched (e.g.
  // "Australia sailings, spring 2027"). This triggers a different no-result
  // message that tells the agent to report the miss and ask the user to
  // redirect — rather than falling back to general cruise-industry knowledge.
  structuredLookupDescription?: string;
}

const DEFAULT_HALFLIVES: Record<string, number> = {
  pricing: 7,
  promo: 14,
  schedule: 30,
  policy: 90,
};

export interface FormattedBlock {
  knowledge_block: string;
  citations: Array<{
    chunk_id: string;
    title: string;
    source_url: string | null;
    confidence: number;
    stars: number;
    excerpt: string;
    is_outdated: boolean;
  }>;
}

const INSTRUCTIONS_BLOCK = `INSTRUCTIONS:
- Treat the chunks above as your primary factual source for this turn.
- Cite retrieved sources inline in natural prose (e.g., "per Royal Caribbean's official site"
  or "from your agency's records"). Do NOT print chunk IDs or star ratings in your reply.
- Prefer higher-confidence (★★★★+) chunks. Hedge on ★★ or below — say so explicitly
  ("based on a less-recent source", "I'm not fully certain").
- For chunks marked "AUTHORITATIVE_OVERRIDE — WIN": prefer this content over any other
  retrieved chunks that disagree, regardless of their authority score.
- For chunks tagged "may be outdated": say so — e.g., "this pricing may have changed".
- If two chunks conflict, surface the conflict honestly. Do not paper over it.
- Do not introduce facts (prices, dates, dining venues, cabin layouts, policies, ship
  amenities) that are NOT in the chunks above. If asked for specifics you cannot ground
  in a chunk, acknowledge: "I don't have specific information on that. Would you like
  me to check with our team?"
- For high-stakes topics (medical, accessibility, legal, dietary, contractual): the
  persona must offer human handoff if confidence is low.`;

const NO_RESULT_BLOCK = `KNOWLEDGE CONTEXT: No retrieved chunks for this turn.

INSTRUCTIONS:
- Do not fabricate specific facts (prices, dates, dining venue names, cabin
  layouts, policies) — you have no verified content on this topic.
- You may share general cruise-industry knowledge with appropriate caveats.
- If the user asks for specifics you cannot verify, acknowledge honestly:
  "I don't have specific information on that. Would you like me to check
  with our team?"
- Consider escalation if the topic is high-stakes (medical, accessibility,
  legal, contractual).`;

export function formatKnowledgeBlock(
  chunks: RetrievedChunk[],
  opts: FormatBlockOpts = {},
): FormattedBlock {
  if (chunks.length === 0) {
    // When a structured lookup ran and came up empty, the agent must NOT fall
    // back to general knowledge and suggest ships or dates it can't verify.
    const block = opts.structuredLookupDescription
      ? `KNOWLEDGE CONTEXT: A sailing search was performed (${opts.structuredLookupDescription}) but no matching sailings were found in inventory.

INSTRUCTIONS:
- Tell the user you searched but couldn't find sailings matching those criteria.
- Ask whether they'd like to try different cruise lines, different dates, or adjust their departure options.
- Do NOT suggest specific ships, itineraries, or sailing dates from general knowledge — you searched real inventory and it came up empty, so general knowledge would be misleading.
- Keep it brief and constructive; the goal is to redirect, not apologise at length.`
      : NO_RESULT_BLOCK;
    return { knowledge_block: block, citations: [] };
  }

  const halflives = { ...DEFAULT_HALFLIVES, ...(opts.categoryHalflives ?? {}) };
  const now = opts.now ?? new Date();

  const lines: string[] = ["KNOWLEDGE CONTEXT (retrieved for this turn):", ""];
  const citations: FormattedBlock["citations"] = [];

  chunks.forEach((c, i) => {
    const conf = c.scoring.composite_confidence ?? 0;
    const stars = starsFor(conf);
    const auth = c.scoring.authority ?? 0;
    const match = c.scoring.match_score ?? 0;
    const recency = c.scoring.recency ?? 0;
    const tierBadge = c.authority_kind === "authoritative_override"
      ? "AUTHORITATIVE_OVERRIDE — WIN"
      : c.scoring.authority_tier ?? "standard";

    const ageDays = c.ingested_at
      ? (now.getTime() - new Date(c.ingested_at).getTime()) / (1000 * 60 * 60 * 24)
      : null;
    const halflife = c.category ? halflives[c.category] : undefined;
    const isOutdated =
      ageDays !== null && halflife !== undefined && ageDays > halflife;

    lines.push(`[Chunk ${i + 1}] ${"★".repeat(stars)}${"☆".repeat(5 - stars)} (confidence ${conf.toFixed(2)})`);
    lines.push(`  Authority: ${auth.toFixed(2)} (${tierBadge})`);
    lines.push(`  Recency: ${recency.toFixed(2)}   Match: ${match.toFixed(2)}`);
    lines.push(`  Category: ${c.category ?? "uncategorized"}`);
    lines.push(`  Source: ${sourceLabel(c)}`);
    if (isOutdated) {
      lines.push(`  ⚠ may be outdated (age ${Math.floor(ageDays!)}d > ${halflife}d halflife)`);
    }
    lines.push(`  Content:`);
    // #748: unambiguous delimiters prevent injected instructions in chunk content
    // from bleeding into the surrounding system-prompt structure. The model sees
    // <<CHUNK_DATA_START>> / <<CHUNK_DATA_END>> as content boundaries, not directives.
    lines.push(`  <<CHUNK_DATA_START>>`);
    lines.push(`  ${c.content.replace(/\n/g, "\n  ")}`);
    lines.push(`  <<CHUNK_DATA_END>>`);
    lines.push("");

    citations.push({
      chunk_id: c.id,
      title: chunkTitle(c),
      source_url: c.source_url,
      confidence: conf,
      stars,
      excerpt: truncate(c.content, 240),
      is_outdated: isOutdated,
    });
  });

  lines.push(INSTRUCTIONS_BLOCK);

  return { knowledge_block: lines.join("\n"), citations };
}

export function starsFor(confidence: number): number {
  if (confidence >= 0.9) return 5;
  if (confidence >= 0.8) return 4;
  if (confidence >= 0.7) return 3;
  if (confidence >= 0.5) return 2;
  if (confidence >= 0.35) return 1;
  return 0;
}

function sourceLabel(c: RetrievedChunk): string {
  if (c.source_type === "tenant_verified") return "your agency's records";
  if (c.source_url) return c.source_url;
  if (c.source_domain) return c.source_domain;
  return c.source_type ?? "internal";
}

function chunkTitle(c: RetrievedChunk): string {
  if (c.source_domain) return c.source_domain;
  if (c.cruise_line_or_supplier) return c.cruise_line_or_supplier;
  if (c.destination) return c.destination;
  return c.category ?? "Retrieved source";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}
