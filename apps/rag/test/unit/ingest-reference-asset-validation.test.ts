// BP37 §33.6.2 — /api/ingest/reference related_asset_ids validation tests.
//
// Two invariants:
//   1. Missing asset IDs → 400 with `related_asset_ids_not_found`.
//   2. Tenant-scope asset referenced from a global chunk → 400 with
//      `asset_scope_mismatch`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let currentCtx = { scope: "write", service_identifier: "platform-admin", user_id: null as string | null, tenant_id: null as string | null };
vi.mock("@/lib/auth/with-service-auth", () => ({
  withServiceAuth: (handler: (req: Request, ctx: typeof currentCtx) => Promise<Response>) => {
    return (req: Request) => handler(req, currentCtx);
  },
}));

// Mock DB — `rag_media_assets` .select(...).in(...) returns whatever
// `mockAssets` is set to; everything else returns no rows.
let mockAssets: Array<{ asset_id: string; scope: "global" | "tenant" }> = [];

vi.mock("@/lib/db/supabase", () => ({
  getRagDb: () => ({
    from(table: string) {
      return {
        select() {
          return {
            in: async () => ({ data: table === "rag_media_assets" ? mockAssets : [], error: null }),
            eq() { return { eq() { return { maybeSingle: async () => ({ data: null, error: null }) }; } }; },
            maybeSingle: async () => ({ data: null, error: null }),
            single: async () => ({ data: null, error: null }),
          };
        },
        insert() {
          return { select() { return { single: async () => ({ data: { id: "new-chunk" }, error: null }) }; } };
        },
        update() {
          return { eq() { return { select() { return { single: async () => ({ data: { id: "existing-chunk" }, error: null }) }; } }; } };
        },
        upsert() {
          return { select() { return { single: async () => ({ data: { id: "x" }, error: null }) }; } };
        },
      };
    },
  }),
}));

vi.mock("@/lib/embeddings/openai", () => ({
  embed: vi.fn(async () => new Array(1536).fill(0.01)),
}));

import { POST } from "../../src/app/api/ingest/reference/route";

const BASE_BODY = {
  source_identifier: "cruisemapper:deck:symphony-deck-09",
  category: "deck_intel",
  text: "Symphony of the Seas Deck 9. Cabin number ranges: 9628–9658, 9660–9700. See referenced deck plan images for layout.",
  source_url: "https://www.cruisemapper.com/ships/symphony/deck-09",
  source_domain: "cruisemapper.com",
  ship: "Symphony of the Seas",
};

function makeReq(body: unknown): Request {
  return new Request("https://rag.test/api/ingest/reference", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockAssets = [];
  currentCtx = { scope: "write", service_identifier: "platform-admin", user_id: null, tenant_id: null };
});
afterEach(() => { vi.clearAllMocks(); });

describe("/api/ingest/reference — related_asset_ids validation", () => {
  it("rejects with 400 when any asset id is missing", async () => {
    mockAssets = [
      { asset_id: "11111111-1111-1111-1111-111111111111", scope: "global" },
      // Second id is missing from mockAssets.
    ];
    const res = await POST(makeReq({
      ...BASE_BODY,
      related_asset_ids: [
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ],
    }), { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; missing: string[] };
    expect(json.error).toBe("related_asset_ids_not_found");
    expect(json.missing).toContain("22222222-2222-2222-2222-222222222222");
  });

  it("rejects with 400 when a referenced asset is tenant-owned", async () => {
    mockAssets = [
      { asset_id: "11111111-1111-1111-1111-111111111111", scope: "global" },
      { asset_id: "22222222-2222-2222-2222-222222222222", scope: "tenant" },
    ];
    const res = await POST(makeReq({
      ...BASE_BODY,
      related_asset_ids: [
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ],
    }), { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; tenant_scope_ids: string[] };
    expect(json.error).toBe("asset_scope_mismatch");
    expect(json.tenant_scope_ids).toContain("22222222-2222-2222-2222-222222222222");
  });

  it("accepts when all referenced assets are global-scope", async () => {
    mockAssets = [
      { asset_id: "11111111-1111-1111-1111-111111111111", scope: "global" },
      { asset_id: "22222222-2222-2222-2222-222222222222", scope: "global" },
    ];
    const res = await POST(makeReq({
      ...BASE_BODY,
      related_asset_ids: [
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ],
    }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(["ingested", "updated"]).toContain(json.status);
  });
});
