// §21.3 — Chunk filtering before knowledge-block injection.
//
// Order of operations:
//   1. Drop chunks with composite_confidence < RAG_CHUNK_CONFIDENCE_FLOOR.
//   2. Drop expired chunks (expires_at < now).
//   3. Drop closed-to-new promo chunks UNLESS the customer already has a
//      live booking (customer_has_booking signal).
//   4. Pricing-topic cap (§21.10 topic guard): pricing chunks above 0.55 are
//      capped at 0.55 — the persona must see "lower confidence" on pricing
//      regardless of how high the chunk scored.
//   5. Similarity dedup at RAG_CHUNK_DEDUP_SIMILARITY_THRESHOLD (if embeddings
//      available; otherwise content-hash dedup).
//   6. Final cap at top N (default 4, range 3–5).

import type { RetrievedChunk } from "./chunk-types";

export interface FilterOpts {
  confidenceFloor?: number;
  dedupSimilarityThreshold?: number;
  topN?: number;
  customerHasBooking?: boolean;
  // If true, apply the §21.10 pricing-topic cap of 0.55.
  isPricingTopic?: boolean;
  now?: Date;
}

const DEFAULT_FLOOR = 0.35;
const DEFAULT_DEDUP = 0.8;
const DEFAULT_TOP_N = 4;
const PRICING_CAP = 0.55;

export function filterChunks(
  chunks: RetrievedChunk[],
  opts: FilterOpts = {},
): RetrievedChunk[] {
  const floor =
    opts.confidenceFloor ??
    Number(process.env.RAG_CHUNK_CONFIDENCE_FLOOR ?? DEFAULT_FLOOR);
  const dedup =
    opts.dedupSimilarityThreshold ??
    Number(process.env.RAG_CHUNK_DEDUP_SIMILARITY_THRESHOLD ?? DEFAULT_DEDUP);
  const topN =
    opts.topN ?? Number(process.env.RAG_CHUNK_TOP_N_DEFAULT ?? DEFAULT_TOP_N);
  const now = opts.now ?? new Date();
  const customerHasBooking = opts.customerHasBooking ?? false;

  // 1. Confidence floor
  let work = chunks.filter(
    (c) => (c.scoring.composite_confidence ?? 0) >= floor,
  );

  // 2. Expiry
  work = work.filter((c) => {
    if (!c.expires_at) return true;
    return new Date(c.expires_at).getTime() >= now.getTime();
  });

  // 3. Closed-to-new promo gate
  work = work.filter((c) => {
    if (c.category !== "promo") return true;
    if (c.promo_status !== "closed_to_new") return true;
    return customerHasBooking;
  });

  // 4. Pricing-topic cap on confidence (§21.10 topic guard)
  if (opts.isPricingTopic) {
    work = work.map((c) => {
      const cur = c.scoring.composite_confidence ?? 0;
      if (cur <= PRICING_CAP) return c;
      return {
        ...c,
        scoring: { ...c.scoring, composite_confidence: PRICING_CAP },
      };
    });
  }

  // 5. Dedup. Prefer embedding similarity; fall back to content-hash.
  work = dedupChunks(work, dedup);

  // 6. Sort descending by composite_confidence and cap.
  work.sort(
    (a, b) =>
      (b.scoring.composite_confidence ?? 0) -
      (a.scoring.composite_confidence ?? 0),
  );

  return work.slice(0, topN);
}

function dedupChunks(chunks: RetrievedChunk[], threshold: number): RetrievedChunk[] {
  const result: RetrievedChunk[] = [];
  const hashSeen = new Set<string>();

  // Sort by confidence so the first into a cluster is the highest-scored.
  const sorted = [...chunks].sort(
    (a, b) =>
      (b.scoring.composite_confidence ?? 0) -
      (a.scoring.composite_confidence ?? 0),
  );

  for (const c of sorted) {
    // Content hash dedup catches exact dupes regardless of embedding presence.
    if (c.content_hash) {
      if (hashSeen.has(c.content_hash)) continue;
      hashSeen.add(c.content_hash);
    }

    // Embedding-based cluster check.
    let dropped = false;
    if (c.embedding && c.embedding.length > 0) {
      for (const kept of result) {
        if (!kept.embedding || kept.embedding.length !== c.embedding.length) continue;
        const sim = cosineSimilarity(c.embedding, kept.embedding);
        if (sim >= threshold) {
          dropped = true;
          break;
        }
      }
    }

    if (!dropped) result.push(c);
  }

  return result;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
