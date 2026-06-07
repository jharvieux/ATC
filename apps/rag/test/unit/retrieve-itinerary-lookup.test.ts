// #826 — fetchItineraryLookupChunks: resolves an exact ship+date lookup to the
// REAL knowledge chunks for the matching sailings (via itineraries.related_chunk_id),
// shaped like the match RPC output with a top-rank synthetic score.

import { describe, it, expect, vi } from "vitest";

// Allow the route module to import without its heavy deps.
vi.mock("@/lib/auth/with-service-auth", () => ({ withServiceAuth: (h: unknown) => h }));
vi.mock("@/lib/embeddings/openai", () => ({ embed: async () => [] }));
vi.mock("@/lib/db/supabase", () => ({ getRagDb: () => ({}) }));

import { fetchItineraryLookupChunks } from "../../src/app/api/retrieve/route";

type Result = { data: unknown; error: unknown };

// Thenable query-builder mock: every chained method returns the builder; awaiting
// it resolves to that table's preset result.
function makeDb(byTable: Record<string, Result>) {
  function builder(table: string) {
    const result = byTable[table] ?? { data: [], error: null };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "ilike", "gte", "lte", "not", "order", "limit", "in", "eq", "or"]) {
      b[m] = () => b;
    }
    b.then = (resolve: (v: Result) => void) => resolve(result);
    return b;
  }
  return { from: (t: string) => builder(t) } as unknown as Parameters<typeof fetchItineraryLookupChunks>[0];
}

const LOOKUP = { ship: "Norwegian Bliss", sail_date_from: "2026-10-03" };

describe("fetchItineraryLookupChunks (#826)", () => {
  it("resolves matching sailings to their real chunks, boosted to top rank", async () => {
    const db = makeDb({
      itineraries: { data: [{ related_chunk_id: "chunk-1" }, { related_chunk_id: "chunk-1" }, { related_chunk_id: null }], error: null },
      knowledge_chunks: { data: [{ id: "chunk-1", content: "Bliss departs Seattle 2026-10-03", scope: "global", authority_auto: 0.4, authority_manual_override: null }], error: null },
    });
    const out = await fetchItineraryLookupChunks(db, "tenant-1", LOOKUP);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "chunk-1",
      match_score: 1,
      recency_score: 1,
      composite_confidence: 1,
      authority_score: 0.4, // falls back to authority_auto
    });
  });

  it("prefers authority_manual_override for the synthetic authority score", async () => {
    const db = makeDb({
      itineraries: { data: [{ related_chunk_id: "c2" }], error: null },
      knowledge_chunks: { data: [{ id: "c2", authority_auto: 0.2, authority_manual_override: 0.9 }], error: null },
    });
    const out = await fetchItineraryLookupChunks(db, "tenant-1", LOOKUP);
    expect(out[0]).toMatchObject({ authority_score: 0.9 });
  });

  it("returns [] when no sailing matches the ship+date", async () => {
    const db = makeDb({ itineraries: { data: [], error: null } });
    expect(await fetchItineraryLookupChunks(db, "tenant-1", LOOKUP)).toEqual([]);
  });

  it("returns [] when the matched sailings have no related chunk", async () => {
    const db = makeDb({ itineraries: { data: [{ related_chunk_id: null }], error: null } });
    expect(await fetchItineraryLookupChunks(db, "tenant-1", LOOKUP)).toEqual([]);
  });

  it("throws on a DB error so the caller degrades to vector-only", async () => {
    const db = makeDb({ itineraries: { data: null, error: { message: "boom" } } });
    await expect(fetchItineraryLookupChunks(db, "tenant-1", LOOKUP)).rejects.toThrow(/itineraries lookup failed/);
  });
});
