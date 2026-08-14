// fetchShipLookupChunks + fetchPortLookupChunks — structured lookups that
// bypass vector search when semantic similarity is unreliable.
//
// WHY these lookups exist: for ship amenity/spec questions ("Where is The Haven
// on the Bliss?", "Send the deck plan") and port-departure queries ("What ships
// leave Port Canaveral on 10/23/26?"), the ANN top-200 candidates routinely
// miss the right chunks because the question vocabulary doesn't match the chunk
// text. The structured paths guarantee the right content reaches the concierge.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/with-service-auth", () => ({ withServiceAuth: (h: unknown) => h }));
vi.mock("@/lib/embeddings/openai", () => ({ embed: async () => [] }));
vi.mock("@/lib/db/supabase", () => ({ getRagDb: () => ({}) }));

import { fetchShipLookupChunks, fetchPortLookupChunks, fetchRegionLookupChunks } from "../../src/app/api/retrieve/route";

type Result = { data: unknown; error: unknown };

// Captures the args of the most recent rpc() call so tests can assert what the
// region lookup forwarded to match_region_itinerary_chunks.
const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];

function makeDb(byTable: Record<string, Result>, rpcResult?: Result) {
  function builder(table: string) {
    const result = byTable[table] ?? { data: [], error: null };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "ilike", "in", "eq", "is", "not", "gte", "lte", "or", "order", "limit"]) {
      b[m] = () => b;
    }
    b.then = (resolve: (v: Result) => void) => resolve(result);
    return b;
  }
  return {
    from: (t: string) => builder(t),
    rpc: async (fn: string, params: Record<string, unknown>) => {
      rpcCalls.push({ fn, params });
      return rpcResult ?? { data: [], error: null };
    },
  } as unknown as Parameters<typeof fetchShipLookupChunks>[0];
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

  // @rls-covered-by apps/rag/test/integration/retrieval-scope-isolation.test.ts#ship lookup scope returns global and tenant A chunks, not tenant B
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

  // WHY (#1589): this is a leading-wildcard ILIKE on knowledge_chunks — a
  // growing table — on the chat critical path. Without a bound it seq-scans and
  // can return an unbounded set for a ship with many intel chunks. The bound
  // must be present (freshest first, so the cap sheds stale chunks) or a
  // popular ship silently blows up retrieval latency. A test that can't fail
  // when the .limit()/.order() is dropped would be worthless, so assert both.
  it("bounds the ship lookup with a freshest-first limit", async () => {
    const calls: Array<{ m: string; args: unknown[] }> = [];
    const b: Record<string, unknown> = {};
    for (const m of ["select", "ilike", "in", "eq", "is", "not", "or", "order", "limit"]) {
      b[m] = (...args: unknown[]) => {
        calls.push({ m, args });
        return b;
      };
    }
    b.then = (resolve: (v: Result) => void) => resolve({ data: [], error: null });
    const db = { from: () => b } as unknown as Parameters<typeof fetchShipLookupChunks>[0];

    await fetchShipLookupChunks(db, "tenant-1", { ship: "Bliss" });

    const order = calls.find((c) => c.m === "order");
    const limit = calls.find((c) => c.m === "limit");
    expect(order?.args[0]).toBe("ingested_at");
    expect(order?.args[1]).toMatchObject({ ascending: false });
    expect(limit?.args[0]).toBe(40);
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

  // @rls-covered-by apps/rag/test/integration/retrieval-scope-isolation.test.ts#port lookup scope returns global and tenant A chunks, not tenant B
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
    // The by-id chunk fetch is shared across the structured lookups, so the
    // error message is the unified "structured chunk fetch failed".
    await expect(
      fetchPortLookupChunks(db, "tenant-1", { departure_port: "Miami", date_from: "2026-06-01" }),
    ).rejects.toThrow(/structured chunk fetch failed/);
  });
});

describe("fetchRegionLookupChunks", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
  });

  const lookup = {
    region_terms: ["Australia"],
    port_terms: ["Sydney", "Brisbane"],
    origin_port_terms: [] as string[],
    date_from: "2027-03-01",
    date_to: "2027-05-31",
  };

  it("forwards origin_port_terms to the RPC (the US→Australia origin filter)", async () => {
    const db = makeDb({}, { data: [], error: null });
    await fetchRegionLookupChunks(db, "tenant-1", {
      ...lookup,
      origin_port_terms: ["Miami", "Los Angeles", "Seward"],
    });
    expect(rpcCalls).toHaveLength(1);
    const call = rpcCalls[0]!;
    expect(call.fn).toBe("match_region_itinerary_chunks");
    expect(call.params.p_origin_port_terms).toEqual(["Miami", "Los Angeles", "Seward"]);
  });

  it("forwards an empty origin set when no origin is named", async () => {
    const db = makeDb({}, { data: [], error: null });
    await fetchRegionLookupChunks(db, "tenant-1", lookup);
    expect(rpcCalls[0]!.params.p_origin_port_terms).toEqual([]);
  });

  it("resolves the RPC's matched chunk ids to real chunks, boosted to 1.0", async () => {
    const db = makeDb(
      {
        knowledge_chunks: {
          data: [
            { id: "s1", scope: "global", authority_auto: 0.6, authority_manual_override: null },
            { id: "s2", scope: "global", authority_auto: 0.4, authority_manual_override: null },
          ],
          error: null,
        },
      },
      { data: [{ related_chunk_id: "s1", first_departure: "2027-03-04" }, { related_chunk_id: "s2", first_departure: "2027-03-09" }], error: null },
    );
    const out = await fetchRegionLookupChunks(db, "tenant-1", lookup);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ match_score: 1, recency_score: 1, composite_confidence: 1 });
  });

  // @rls-covered-by apps/rag/test/integration/retrieval-scope-isolation.test.ts#region lookup scope returns global and tenant A chunks, not tenant B
  it("drops chunks from a different tenant (second isolation layer)", async () => {
    const db = makeDb(
      {
        knowledge_chunks: {
          data: [{ id: "g1", scope: "global" }, { id: "other", scope: "tenant", tenant_id: "tenant-2" }],
          error: null,
        },
      },
      { data: [{ related_chunk_id: "g1", first_departure: "2027-03-04" }, { related_chunk_id: "other", first_departure: "2027-03-05" }], error: null },
    );
    const out = await fetchRegionLookupChunks(db, "tenant-1", lookup);
    expect(out.map((c) => (c as { id: string }).id)).toEqual(["g1"]);
  });

  it("returns [] when the RPC matches no sailings", async () => {
    const db = makeDb({}, { data: [], error: null });
    expect(await fetchRegionLookupChunks(db, "tenant-1", lookup)).toEqual([]);
  });

  it("throws on RPC error so the caller degrades to vector-only", async () => {
    const db = makeDb({}, { data: null, error: { message: "function missing" } });
    await expect(fetchRegionLookupChunks(db, "tenant-1", lookup)).rejects.toThrow(/region itinerary lookup failed/);
  });
});
