// §21.3 — chunk filtering tests.
// Why these matter: an under-aggressive filter floods the persona with low-
// quality content and bloats the prompt; an over-aggressive filter starves
// the persona and forces the "no result" path on turns that had usable data.

import { describe, it, expect } from "vitest";
import { filterChunks } from "@/lib/rag/filter-chunks";
import type { RetrievedChunk } from "@/lib/rag/chunk-types";

type ChunkOver = Partial<Omit<RetrievedChunk, "scoring" | "metadata">> & {
  scoring?: Partial<RetrievedChunk["scoring"]>;
  metadata?: Partial<RetrievedChunk["metadata"]>;
};

function chunk(over: ChunkOver = {}): RetrievedChunk {
  return {
    id: over.id ?? "c-" + Math.random().toString(36).slice(2, 8),
    content: over.content ?? "Sample content text.",
    content_hash: over.content_hash ?? null,
    scope: over.scope ?? "tenant",
    tenant_id: over.tenant_id ?? "t",
    category: over.category ?? null,
    cruise_line_or_supplier: null,
    ship_or_property: null,
    destination: null,
    agent_scope: null,
    tags: null,
    source_type: null,
    source_url: null,
    source_domain: null,
    ingested_at: over.ingested_at ?? null,
    expires_at: over.expires_at ?? null,
    contains_pricing: null,
    scoring: {
      match_score: 0.5,
      authority: 0.5,
      authority_tier: null,
      recency: 0.5,
      composite_confidence: 0.7,
      ...over.scoring,
    },
    metadata: {
      ingested_at: null,
      expires_at: null,
      is_promo: false,
      ...over.metadata,
    },
    ...(over.embedding !== undefined && { embedding: over.embedding }),
    ...(over.promo_status !== undefined && { promo_status: over.promo_status }),
    ...(over.authority_kind !== undefined && { authority_kind: over.authority_kind }),
  };
}

describe("filterChunks — §21.3", () => {
  it("drops chunks below the confidence floor", () => {
    const chunks = [
      chunk({ id: "high", scoring: { composite_confidence: 0.9 } }),
      chunk({ id: "low",  scoring: { composite_confidence: 0.30 } }),
      chunk({ id: "mid",  scoring: { composite_confidence: 0.40 } }),
    ];
    const out = filterChunks(chunks, { confidenceFloor: 0.35, topN: 5 });
    expect(out.map((c) => c.id).sort()).toEqual(["high", "mid"]);
  });

  it("drops expired chunks", () => {
    const past = new Date(Date.now() - 86400_000).toISOString();
    const future = new Date(Date.now() + 86400_000).toISOString();
    const chunks = [
      chunk({ id: "live",    expires_at: future }),
      chunk({ id: "expired", expires_at: past }),
      chunk({ id: "no-exp",  expires_at: null }),
    ];
    const out = filterChunks(chunks, { topN: 5 });
    expect(out.map((c) => c.id).sort()).toEqual(["live", "no-exp"]);
  });

  it("drops closed-to-new promo chunks unless customer has a booking", () => {
    const chunks = [
      chunk({ id: "open",   category: "promo", promo_status: "open" }),
      chunk({ id: "closed", category: "promo", promo_status: "closed_to_new" }),
    ];
    const noBooking = filterChunks(chunks, { customerHasBooking: false, topN: 5 });
    expect(noBooking.map((c) => c.id).sort()).toEqual(["open"]);
    const withBooking = filterChunks(chunks, { customerHasBooking: true, topN: 5 });
    expect(withBooking.map((c) => c.id).sort()).toEqual(["closed", "open"]);
  });

  it("caps pricing chunks at 0.55 confidence when topic is pricing (§21.10)", () => {
    const chunks = [
      chunk({ id: "p1", scoring: { composite_confidence: 0.95 } }),
      chunk({ id: "p2", scoring: { composite_confidence: 0.50 } }),
    ];
    const out = filterChunks(chunks, { isPricingTopic: true, topN: 5 });
    const p1 = out.find((c) => c.id === "p1")!;
    expect(p1.scoring.composite_confidence).toBeLessThanOrEqual(0.55 + 1e-9);
  });

  it("dedups by content_hash", () => {
    const chunks = [
      chunk({ id: "a", content_hash: "h1" }),
      chunk({ id: "b", content_hash: "h1" }),
      chunk({ id: "c", content_hash: "h2" }),
    ];
    const out = filterChunks(chunks, { topN: 5 });
    expect(out.length).toBe(2);
  });

  it("dedups by embedding similarity above threshold", () => {
    const e1 = [1, 0, 0];
    const e2 = [0.99, 0.01, 0]; // ~1.0 cosine — should dedup with e1
    const e3 = [0, 1, 0];        // orthogonal — kept
    const chunks = [
      chunk({ id: "a", embedding: e1, scoring: { composite_confidence: 0.9 } }),
      chunk({ id: "b", embedding: e2, scoring: { composite_confidence: 0.85 } }),
      chunk({ id: "c", embedding: e3, scoring: { composite_confidence: 0.8 } }),
    ];
    const out = filterChunks(chunks, { dedupSimilarityThreshold: 0.8, topN: 5 });
    // a (highest in cluster) and c are kept; b dropped as duplicate of a
    expect(out.map((c) => c.id).sort()).toEqual(["a", "c"]);
  });

  it("caps at topN sorted by confidence descending", () => {
    const chunks = [
      chunk({ id: "a", scoring: { composite_confidence: 0.5 } }),
      chunk({ id: "b", scoring: { composite_confidence: 0.9 } }),
      chunk({ id: "c", scoring: { composite_confidence: 0.7 } }),
      chunk({ id: "d", scoring: { composite_confidence: 0.6 } }),
      chunk({ id: "e", scoring: { composite_confidence: 0.4 } }),
    ];
    const out = filterChunks(chunks, { topN: 3 });
    expect(out.map((c) => c.id)).toEqual(["b", "c", "d"]);
  });
});
