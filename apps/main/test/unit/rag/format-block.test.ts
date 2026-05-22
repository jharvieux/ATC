// §21.4 — Knowledge block formatting tests.
// Why these matter: the persona prompt instructions reference the block
// structure directly (★ ratings, INSTRUCTIONS heading, no-result block).
// A drift in the format silently disables the persona's defense behaviors.

import { describe, it, expect } from "vitest";
import { formatKnowledgeBlock, starsFor } from "@/lib/rag/format-block";
import type { RetrievedChunk } from "@/lib/rag/chunk-types";

function ch(over: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    id: "c1",
    content: "Sample.",
    content_hash: null,
    scope: "tenant",
    tenant_id: "t",
    category: "policy",
    cruise_line_or_supplier: null,
    ship_or_property: null,
    destination: null,
    agent_scope: null,
    tags: null,
    source_type: "manual",
    source_url: "https://example.com/policy",
    source_domain: "example.com",
    ingested_at: new Date().toISOString(),
    expires_at: null,
    contains_pricing: null,
    scoring: {
      match_score: 0.8,
      authority: 0.7,
      authority_tier: "standard",
      recency: 0.9,
      composite_confidence: 0.85,
    },
    metadata: { ingested_at: null, expires_at: null, is_promo: false },
    ...over,
  };
}

describe("formatKnowledgeBlock — §21.4", () => {
  it("returns the no-result block when chunks is empty (§21.9)", () => {
    const out = formatKnowledgeBlock([]);
    expect(out.knowledge_block).toContain("KNOWLEDGE CONTEXT: No retrieved chunks");
    expect(out.knowledge_block).toContain("Do not fabricate specific facts");
    expect(out.citations).toEqual([]);
  });

  it("renders chunks with star ratings and INSTRUCTIONS footer", () => {
    const out = formatKnowledgeBlock([ch()]);
    expect(out.knowledge_block).toContain("KNOWLEDGE CONTEXT (retrieved for this turn):");
    expect(out.knowledge_block).toContain("[Chunk 1]");
    expect(out.knowledge_block).toMatch(/★★★★/); // 0.85 → 4 stars
    expect(out.knowledge_block).toContain("INSTRUCTIONS:");
    expect(out.knowledge_block).toContain("Cite retrieved sources inline");
    expect(out.citations[0]?.stars).toBe(4);
  });

  it("tags chunks above category half-life as 'may be outdated' (§21.7)", () => {
    const oldChunk = ch({
      category: "pricing",
      ingested_at: new Date(Date.now() - 30 * 86400_000).toISOString(),
    });
    const out = formatKnowledgeBlock([oldChunk], {
      categoryHalflives: { pricing: 7 },
    });
    expect(out.knowledge_block).toContain("may be outdated");
    expect(out.citations[0]?.is_outdated).toBe(true);
  });

  it("uses 'your agency's records' label for tenant_verified source (§21.5)", () => {
    const c = ch({ source_type: "tenant_verified", source_url: null, source_domain: null });
    const out = formatKnowledgeBlock([c]);
    expect(out.knowledge_block).toContain("your agency's records");
  });

  it("tags AUTHORITATIVE_OVERRIDE chunks for the persona (§21.8)", () => {
    const c = ch({ authority_kind: "authoritative_override" });
    const out = formatKnowledgeBlock([c]);
    expect(out.knowledge_block).toContain("AUTHORITATIVE_OVERRIDE — WIN");
  });

  it("starsFor maps boundaries correctly", () => {
    expect(starsFor(0.95)).toBe(5);
    expect(starsFor(0.90)).toBe(5);
    expect(starsFor(0.85)).toBe(4);
    expect(starsFor(0.70)).toBe(3);
    expect(starsFor(0.50)).toBe(2);
    expect(starsFor(0.35)).toBe(1);
    expect(starsFor(0.20)).toBe(0);
  });
});
