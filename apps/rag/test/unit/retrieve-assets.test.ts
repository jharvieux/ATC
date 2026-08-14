// BP38 §33.6.4 — /api/retrieve asset metadata hydration tests.
//
// Four scenarios from the spec:
//   1. chunks with no assets → empty `assets`, empty `related_asset_ids`
//   2. one asset per chunk → assets array contains one entry per unique asset
//   3. shared asset across chunks → assets has 1 entry, both chunks list ID
//   4. referenced asset is missing → chunk returned, ID dropped, log

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-000000000002";

let currentCtx = {
  scope: "read" as string,
  service_identifier: "tenant-app",
  user_id: USER_ID as string | null,
  tenant_id: TENANT_ID as string | null,
};

vi.mock("@/lib/auth/with-service-auth", () => ({
  withServiceAuth: (handler: (req: Request, ctx: typeof currentCtx) => Promise<Response>) => {
    return (req: Request) => handler(req, currentCtx);
  },
}));

// Mock embedding (any non-zero vector works for these tests)
vi.mock("@/lib/embeddings/openai", () => ({
  embed: vi.fn(async () => new Array(1536).fill(0.01)),
}));

// Mock DB — pluggable per test via these module-level variables.
interface ChunkRpcRow { id: string; content: string; content_hash: string; scope: string; tenant_id: string | null; category: string; cruise_line_or_supplier: string | null; ship_or_property: string | null; destination: string | null; agent_scope: unknown; tags: unknown; source_type: string; source_url: string | null; source_domain: string | null; ingested_at: string; expires_at: string | null; contains_pricing: boolean; sell_by_at: string | null; match_score: number; authority_score: number; recency_score: number; composite_confidence: number; authority_auto: number; authority_manual_override: number | null; }
interface AssetLinkRow { id: string; related_asset_ids: string[]; scope: "global" | "tenant"; tenant_id: string | null }
interface AssetRow { asset_id: string; kind: string; entity_type: string; entity_id: string; scope: "global" | "tenant"; tenant_id: string | null; image_url: string; source_page_url: string; attribution: string; caption: string | null; width_px: number | null; height_px: number | null; }

let rpcChunks: ChunkRpcRow[] = [];
let assetLinks: AssetLinkRow[] = [];
let assetRows: AssetRow[] = [];
// #939: inject a DB error on the rag_media_assets SELECT to test fail-loud.
let assetRowsError: { message: string } | null = null;
// Captures the .or() filter the rag_media_assets query applies, so a test can
// assert the DB-layer tenant predicate is present (D-091 #395).
let capturedAssetOrFilter: string | null = null;
// #743: captures the .or() filter the knowledge_chunks re-query applies.
let capturedChunkOrFilter: string | null = null;

vi.mock("@/lib/db/supabase", () => ({
  getRagDb: () => ({
    rpc: async () => ({ data: rpcChunks, error: null }),
    from(table: string) {
      const result =
        table === "knowledge_chunks"
          ? { data: assetLinks as unknown[], error: null }
          : table === "rag_media_assets"
            ? { data: assetRowsError ? null : (assetRows as unknown[]), error: assetRowsError ?? null }
            : { data: [] as unknown[], error: null };
      return {
        select() {
          const builder = {
            in: () => builder,
            or: (filter: string) => {
              if (table === "rag_media_assets") capturedAssetOrFilter = filter;
              if (table === "knowledge_chunks") capturedChunkOrFilter = filter;
              return builder;
            },
            then: (resolve: (v: typeof result) => unknown) => resolve(result),
          };
          return builder;
        },
        insert: () => Promise.resolve({ data: null, error: null }),
      };
    },
  }),
}));

import { POST } from "../../src/app/api/retrieve/route";

function rpcChunk(over: Partial<ChunkRpcRow> = {}): ChunkRpcRow {
  return {
    id: "chunk-1",
    content: "ship spec text",
    content_hash: "hash",
    scope: "global",
    tenant_id: null,
    category: "ship_intel",
    cruise_line_or_supplier: "RCL",
    ship_or_property: "Symphony of the Seas",
    destination: null,
    agent_scope: null,
    tags: null,
    source_type: "scraped_reference",
    source_url: "https://www.cruisemapper.com/ships/symphony",
    source_domain: "cruisemapper.com",
    ingested_at: "2026-05-01T00:00:00Z",
    expires_at: null,
    contains_pricing: false,
    sell_by_at: null,
    match_score: 0.8,
    authority_score: 0.88,
    recency_score: 0.95,
    composite_confidence: 0.7,
    authority_auto: 0.88,
    authority_manual_override: null,
    ...over,
  };
}

function makeReq(): Request {
  return new Request("https://rag.test/api/retrieve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: "tell me about Symphony of the Seas",
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      conversation_id: "00000000-0000-0000-0000-000000000003",
      persona_id: "00000000-0000-0000-0000-000000000004",
      top_k: 5,
    }),
  });
}

beforeEach(() => {
  rpcChunks = [];
  assetLinks = [];
  assetRows = [];
  assetRowsError = null;
  capturedAssetOrFilter = null;
  capturedChunkOrFilter = null;
  currentCtx = { scope: "read", service_identifier: "tenant-app", user_id: USER_ID, tenant_id: TENANT_ID };
});
afterEach(() => { vi.clearAllMocks(); });

describe("POST /api/retrieve — asset hydration (BP38)", () => {
  it("scenario 1: chunks without assets → empty assets + empty related_asset_ids", async () => {
    rpcChunks = [rpcChunk({ id: "c1" })];
    assetLinks = [{ id: "c1", related_asset_ids: [], scope: "global", tenant_id: null }];

    const res = await POST(makeReq(), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { chunks: Array<{ id: string; related_asset_ids: string[] }>; assets: unknown[] };
    expect(json.assets).toEqual([]);
    expect(json.chunks).toHaveLength(1);
    expect(json.chunks[0]!.related_asset_ids).toEqual([]);
  });

  it("scenario 2: one asset per chunk → assets array has one entry per unique asset", async () => {
    rpcChunks = [rpcChunk({ id: "c1" }), rpcChunk({ id: "c2" })];
    assetLinks = [
      { id: "c1", related_asset_ids: ["a-1111-1111-1111-111111111111"], scope: "global", tenant_id: null },
      { id: "c2", related_asset_ids: ["a-2222-2222-2222-222222222222"], scope: "global", tenant_id: null },
    ];
    assetRows = [
      { asset_id: "a-1111-1111-1111-111111111111", kind: "deck_plan", entity_type: "deck", entity_id: "e1", scope: "global", tenant_id: null, image_url: "https://www.cruisemapper.com/x.jpg", source_page_url: "https://www.cruisemapper.com/p1", attribution: "Image: CruiseMapper", caption: null, width_px: 800, height_px: 600 },
      { asset_id: "a-2222-2222-2222-222222222222", kind: "deck_plan", entity_type: "deck", entity_id: "e2", scope: "global", tenant_id: null, image_url: "https://www.cruisemapper.com/y.jpg", source_page_url: "https://www.cruisemapper.com/p2", attribution: "Image: CruiseMapper", caption: null, width_px: 800, height_px: 600 },
    ];

    const res = await POST(makeReq(), { params: Promise.resolve({}) });
    const json = (await res.json()) as { chunks: Array<{ id: string; related_asset_ids: string[] }>; assets: Array<{ asset_id: string }> };
    expect(json.assets).toHaveLength(2);
    expect(json.chunks[0]!.related_asset_ids).toEqual(["a-1111-1111-1111-111111111111"]);
    expect(json.chunks[1]!.related_asset_ids).toEqual(["a-2222-2222-2222-222222222222"]);
  });

  it("scenario 3: shared asset across chunks → deduped in assets, both chunks list it", async () => {
    rpcChunks = [rpcChunk({ id: "c1" }), rpcChunk({ id: "c2" })];
    const shared = "a-9999-9999-9999-999999999999";
    assetLinks = [
      { id: "c1", related_asset_ids: [shared], scope: "global", tenant_id: null },
      { id: "c2", related_asset_ids: [shared], scope: "global", tenant_id: null },
    ];
    assetRows = [
      { asset_id: shared, kind: "deck_plan", entity_type: "deck", entity_id: "e9", scope: "global", tenant_id: null, image_url: "https://www.cruisemapper.com/shared.jpg", source_page_url: "https://www.cruisemapper.com/p", attribution: "Image: CruiseMapper", caption: null, width_px: 800, height_px: 600 },
    ];

    const res = await POST(makeReq(), { params: Promise.resolve({}) });
    const json = (await res.json()) as { chunks: Array<{ related_asset_ids: string[] }>; assets: Array<{ asset_id: string }> };
    expect(json.assets).toHaveLength(1);
    expect(json.assets[0]!.asset_id).toBe(shared);
    expect(json.chunks[0]!.related_asset_ids).toContain(shared);
    expect(json.chunks[1]!.related_asset_ids).toContain(shared);
  });

  it("scenario 4: chunk references a missing asset → chunk returned, ID dropped", async () => {
    rpcChunks = [rpcChunk({ id: "c1" })];
    assetLinks = [
      { id: "c1", related_asset_ids: ["a-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "a-bbbb-bbbb-bbbb-bbbbbbbbbbbb"], scope: "global", tenant_id: null },
    ];
    assetRows = [
      // Only the first asset exists; the second was deleted between ingest and retrieve.
      { asset_id: "a-aaaa-aaaa-aaaa-aaaaaaaaaaaa", kind: "deck_plan", entity_type: "deck", entity_id: "e-a", scope: "global", tenant_id: null, image_url: "https://www.cruisemapper.com/a.jpg", source_page_url: "https://www.cruisemapper.com/p", attribution: "Image: CruiseMapper", caption: null, width_px: 800, height_px: 600 },
    ];

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await POST(makeReq(), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { chunks: Array<{ related_asset_ids: string[] }>; assets: Array<{ asset_id: string }> };
    expect(json.assets).toHaveLength(1);
    expect(json.chunks[0]!.related_asset_ids).toEqual(["a-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dropped 1 asset id"),
      expect.any(Object),
    );
    warn.mockRestore();
  });

  // @rls-covered-by apps/rag/test/integration/retrieval-scope-isolation.test.ts#asset hydration scope returns global and tenant A assets, not tenant B
  it("scope filter: tenant-scope asset belonging to another tenant is dropped", async () => {
    rpcChunks = [rpcChunk({ id: "c1" })];
    const offlimits = "a-7777-7777-7777-777777777777";
    assetLinks = [{ id: "c1", related_asset_ids: [offlimits], scope: "global", tenant_id: null }];
    assetRows = [
      { asset_id: offlimits, kind: "deck_plan", entity_type: "deck", entity_id: "x", scope: "tenant", tenant_id: "11111111-1111-1111-1111-111111111111", image_url: "https://www.cruisemapper.com/z.jpg", source_page_url: "https://www.cruisemapper.com/p", attribution: "Image: CruiseMapper", caption: null, width_px: 800, height_px: 600 },
    ];

    const res = await POST(makeReq(), { params: Promise.resolve({}) });
    const json = (await res.json()) as { chunks: Array<{ related_asset_ids: string[] }>; assets: Array<unknown> };
    expect(json.assets).toEqual([]);
    expect(json.chunks[0]!.related_asset_ids).toEqual([]);
  });

  // @rls-covered-by apps/rag/test/integration/retrieval-scope-isolation.test.ts#asset hydration scope returns global and tenant A assets, not tenant B
  it("two-layer isolation (#395): the rag_media_assets query carries a DB-layer scope/tenant .or() predicate", async () => {
    // The JS `continue` (tested above) is layer two. This pins layer one — the
    // DB-side filter — so a regression that drops .or() and leaves only the JS
    // check (the exact single-layer pattern D-091 #395 flags) fails here.
    rpcChunks = [rpcChunk({ id: "c1" })];
    const assetId = "a-1111-1111-1111-111111111111";
    assetLinks = [{ id: "c1", related_asset_ids: [assetId], scope: "global", tenant_id: null }];
    assetRows = [
      { asset_id: assetId, kind: "deck_plan", entity_type: "deck", entity_id: "e1", scope: "global", tenant_id: null, image_url: "https://www.cruisemapper.com/x.jpg", source_page_url: "https://www.cruisemapper.com/p", attribution: "Image: CruiseMapper", caption: null, width_px: 800, height_px: 600 },
    ];

    const res = await POST(makeReq(), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(capturedAssetOrFilter).toBe(`scope.eq.global,tenant_id.eq.${TENANT_ID}`);
  });

  // @rls-covered-by apps/rag/test/integration/retrieval-scope-isolation.test.ts#chunk hydration scope returns global and tenant A chunks, not tenant B
  it("#743 DB-layer isolation: knowledge_chunks re-query carries scope/tenant .or() predicate", async () => {
    // Layer 1 of the two-layer isolation fix for #743: the DB query must include
    // the scope/tenant filter so another tenant's chunks can't be returned by the
    // service-role re-query even if they share a chunk ID.
    rpcChunks = [rpcChunk({ id: "c1" })];
    assetLinks = [{ id: "c1", related_asset_ids: [], scope: "global", tenant_id: null }];

    const res = await POST(makeReq(), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(capturedChunkOrFilter).toBe(`scope.eq.global,tenant_id.eq.${TENANT_ID}`);
  });

  // @rls-covered-by apps/rag/test/integration/retrieval-scope-isolation.test.ts#chunk hydration scope returns global and tenant A chunks, not tenant B
  it("#743 JS-layer isolation: tenant-scope chunk belonging to another tenant is excluded from assetIdsByChunk", async () => {
    // Layer 2: even if the .or() were somehow absent, the JS continue guard
    // keeps another tenant's chunk data out of the response.
    rpcChunks = [rpcChunk({ id: "c1" })];
    const otherTenant = "22222222-2222-2222-2222-222222222222";
    const crossTenantAsset = "a-cccc-cccc-cccc-cccccccccccc";
    assetLinks = [{
      id: "c1",
      related_asset_ids: [crossTenantAsset],
      scope: "tenant",
      tenant_id: otherTenant,
    }];
    assetRows = [];

    const res = await POST(makeReq(), { params: Promise.resolve({}) });
    const json = (await res.json()) as { chunks: Array<{ related_asset_ids: string[] }>; assets: Array<unknown> };
    expect(json.chunks[0]!.related_asset_ids).toEqual([]);
    expect(json.assets).toEqual([]);
  });

  it("#939 fail-loud: rag_media_assets DB error surfaces as 500, not silent empty-assets response", async () => {
    // Prior to the fix, { data: assetRows } discarded the error and treated
    // DB failures as "no assets" — indistinguishable from a legitimate empty
    // result. This test pins the fail-loud contract: a DB error must propagate
    // to a 500 so callers know the response is degraded.
    rpcChunks = [rpcChunk({ id: "c1" })];
    assetLinks = [{ id: "c1", related_asset_ids: ["a-1111-1111-1111-111111111111"], scope: "global", tenant_id: null }];
    assetRowsError = { message: "connection timeout" };

    const res = await POST(makeReq(), { params: Promise.resolve({}) });
    expect(res.status).toBe(500);
  });
});
