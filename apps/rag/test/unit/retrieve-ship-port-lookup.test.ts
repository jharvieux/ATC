// fetchShipLookupChunks + fetchPortLookupChunks — structured lookups that
// bypass vector search when semantic similarity is unreliable.
//
// WHY these lookups exist: for ship amenity/spec questions ("Where is The Haven
// on the Bliss?", "Send the deck plan") and port-departure queries ("What ships
// leave Port Canaveral on 10/23/26?"), the ANN top-200 candidates routinely
// miss the right chunks because the question vocabulary doesn't match the chunk
// text. The structured paths guarantee the right content reaches the concierge.

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/auth/with-service-auth", () => ({ withServiceAuth: (h: unknown) => h }));
vi.mock("@/lib/embeddings/openai", () => ({ embed: async () => [] }));
vi.mock("@/lib/db/supabase", () => ({ getRagDb: () => ({}) }));

import { fetchShipLookupChunks, fetchPortLookupChunks } from "../../src/app/api/retrieve/route";

type Result = { data: unknown; error: unknown };

function makeDb(byTable: Record<string, Result>) {
  function builder(table: string) {
    const result = byTable[table] ?? { data: [], error: null };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "ilike", "in", "eq", "is", "not", "gte", "lte", "or", "order", "limit"]) {
      b[m] = () => b;
    }
    b.then = (resolve: (v: Result) => void) => resolve(result);
    return b;
  }
  return { from: (t: string) => builder(t) } as unknown as Parameters<typeof fetchShipLookupChunks>[0];
}

// ── fetchShipLookupChunks ─────────────────────────────────────────────────────

describe("fetchShipLookupChunks", () => {
  it("returns deck_intel + ship_intel chunks for the named ship, boosted to 0.95", async () => {
    const db = makeDb({
      knowledge_chunks: {
        data: [
          { id: "deck-1", scope: "global", category: "deck_intel", authority_auto: 0.5, authority_manual_override: null },
          { id: "spec-1", scope: "global", category: "ship_intel", authority_auto: 0.6, authority_manual_override: 0.8 },
        ],
        error: null,
      },
    });
    const out = await fetchShipLookupChunks(db, "tenant-1", { ship: "Norwegian Bliss" });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ match_score: 0.95, recency_score: 0.95, composite_confidence: 0.95, authority_score: 0.5 });
    expect(out[1]).toMatchObject({ authority_score: 0.8 }); // prefers manual override
  });

  it("drops chunks from a different tenant (second isolation layer)", async () => {
    const db = makeDb({
      knowledge_chunks: {
        data: [
          { id: "g1", scope: "global" },
          { id: "t-other", scope: "tenant", tenant_id: "tenant-2" },
          { id: "t-mine", scope: "tenant", tenant_id: "tenant-1" },
        ],
        error: null,
      },
    });
    const out = await fetchShipLookupChunks(db, "tenant-1", { ship: "Bliss" });
    expect(out.map((c) => (c as { id: string }).id)).toEqual(["g1", "t-mine"]);
  });

  it("returns [] when no deck_intel/ship_intel exists for the ship", async () => {
    const db = makeDb({ knowledge_chunks: { data: [], error: null } });
    expect(await fetchShipLookupChunks(db, "tenant-1", { ship: "Unknown Ship" })).toEqual([]);
  });

  it("throws on DB error so caller degrades to vector-only", async () => {
    const db = makeDb({ knowledge_chunks: { data: null, error: { message: "timeout" } } });
    await expect(fetchShipLookupChunks(db, "tenant-1", { ship: "Bliss" })).rejects.toThrow(/ship lookup failed/);
  });
});

// ── fetchPortLookupChunks ─────────────────────────────────────────────────────

describe("fetchPortLookupChunks", () => {
  it("resolves itineraries by departure_port+date to their real chunks, boosted to 1.0", async () => {
    const db = makeDb({
      itineraries: {
        data: [{ related_chunk_id: "sailing-1" }, { related_chunk_id: "sailing-2" }, { related_chunk_id: null }],
        error: null,
      },
      knowledge_chunks: {
        data: [
          { id: "sailing-1", scope: "global", authority_auto: 0.7, authority_manual_override: null },
          { id: "sailing-2", scope: "global", authority_auto: 0.5, authority_manual_override: null },
        ],
        error: null,
      },
    });
    const out = await fetchPortLookupChunks(db, "tenant-1", {
      departure_port: "Port Canaveral",
      date_from: "2026-10-23",
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ match_score: 1, recency_score: 1, composite_confidence: 1 });
  });

  it("deduplicates chunk IDs from multiple itinerary rows", async () => {
    const db = makeDb({
      itineraries: { data: [{ related_chunk_id: "c1" }, { related_chunk_id: "c1" }], error: null },
      knowledge_chunks: { data: [{ id: "c1", scope: "global" }], error: null },
    });
    const out = await fetchPortLookupChunks(db, "tenant-1", { departure_port: "Miami", date_from: "2026-06-01" });
    expect(out).toHaveLength(1);
  });

  it("drops chunks from a different tenant (second isolation layer)", async () => {
    const db = makeDb({
      itineraries: { data: [{ related_chunk_id: "g1" }, { related_chunk_id: "other" }], error: null },
      knowledge_chunks: {
        data: [{ id: "g1", scope: "global" }, { id: "other", scope: "tenant", tenant_id: "tenant-2" }],
        error: null,
      },
    });
    const out = await fetchPortLookupChunks(db, "tenant-1", { departure_port: "Miami", date_from: "2026-06-01" });
    expect(out.map((c) => (c as { id: string }).id)).toEqual(["g1"]);
  });

  it("returns [] when no itinerary rows match the port+date", async () => {
    const db = makeDb({ itineraries: { data: [], error: null } });
    expect(await fetchPortLookupChunks(db, "tenant-1", { departure_port: "Miami", date_from: "2026-06-01" })).toEqual([]);
  });

  it("throws on itineraries DB error so caller degrades to vector-only", async () => {
    const db = makeDb({ itineraries: { data: null, error: { message: "connection refused" } } });
    await expect(
      fetchPortLookupChunks(db, "tenant-1", { departure_port: "Miami", date_from: "2026-06-01" }),
    ).rejects.toThrow(/port lookup failed/);
  });

  it("throws on chunk-fetch DB error (second error path) so caller degrades to vector-only", async () => {
    const db = makeDb({
      itineraries: { data: [{ related_chunk_id: "c1" }], error: null },
      knowledge_chunks: { data: null, error: { message: "timeout" } },
    });
    await expect(
      fetchPortLookupChunks(db, "tenant-1", { departure_port: "Miami", date_from: "2026-06-01" }),
    ).rejects.toThrow(/port chunk fetch failed/);
  });
});
