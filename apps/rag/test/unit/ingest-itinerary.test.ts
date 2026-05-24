// BP35 §33.4 — /api/ingest/itinerary unit tests.
//
// Three core invariants:
//   1. Authn — non-platform-admin callers are rejected with 403.
//   2. PII guard — text containing zero-tolerance PII returns 422.
//   3. Idempotency — same composite key + same content_hash returns
//      {status:'unchanged'} without re-embedding or writing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock the auth wrapper to inject ctx values per test ────────────────────
let currentCtx: { scope: string; service_identifier: string; user_id: string | null; tenant_id: string | null } = {
  scope: "write",
  service_identifier: "platform-admin",
  user_id: null,
  tenant_id: null,
};
vi.mock("@/lib/auth/with-service-auth", () => ({
  withServiceAuth: (handler: (req: Request, ctx: typeof currentCtx) => Promise<Response>) => {
    return (req: Request) => handler(req, currentCtx);
  },
}));

// ── Mock the RAG DB ─────────────────────────────────────────────────────────
interface DbCall { table: string; op: string; payload?: unknown }
const dbCalls: DbCall[] = [];
let existingItinerary: { id: string; content_hash: string; related_chunk_id: string | null } | null = null;

vi.mock("@/lib/db/supabase", () => ({
  getRagDb: () => ({
    from(table: string) {
      const ctx = { table, eqMatch: {} as Record<string, unknown> };
      const builder = {
        select() {
          return {
            eq(col: string, v: unknown) {
              ctx.eqMatch[col] = v;
              return this;
            },
            async maybeSingle() {
              if (ctx.table === "itineraries") {
                return { data: existingItinerary, error: null };
              }
              return { data: null, error: null };
            },
            async single() {
              return { data: null, error: null };
            },
          };
        },
        insert(payload: unknown) {
          dbCalls.push({ table, op: "insert", payload });
          return {
            select() {
              return {
                async single() {
                  return { data: { id: `${table}-new-id` }, error: null };
                },
              };
            },
          };
        },
        update(payload: unknown) {
          dbCalls.push({ table, op: "update", payload });
          return {
            eq() {
              return {
                select() {
                  return {
                    async single() {
                      return { data: { id: existingItinerary?.related_chunk_id ?? "chunk-id" }, error: null };
                    },
                  };
                },
              };
            },
          };
        },
        upsert(payload: unknown) {
          dbCalls.push({ table, op: "upsert", payload });
          return {
            select() {
              return {
                async single() {
                  return { data: { id: "itinerary-id" }, error: null };
                },
              };
            },
          };
        },
      };
      return builder;
    },
  }),
}));

// ── Mock the embed function — proves we DON'T call it on unchanged path ────
const embedCalls: string[] = [];
vi.mock("@/lib/embeddings/openai", () => ({
  embed: vi.fn(async (text: string) => {
    embedCalls.push(text);
    return new Array(1536).fill(0.01);
  }),
}));

import { POST } from "../../src/app/api/ingest/itinerary/route";

const VALID_BODY = {
  cruise_line: "RCL",
  ship: "Symphony of the Seas",
  departure_date: "2026-08-15",
  departure_port: "Miami",
  duration_nights: 7,
  ports_of_call: ["Cozumel", "Roatán", "Costa Maya"],
  region: "caribbean",
  starting_price_usd: 649,
  source_url: "https://www.cruisemapper.com/cruise-itinerary/123",
  text: "Royal Caribbean's Symphony of the Seas departs Miami on 2026-08-15 for a 7-night cruise visiting Cozumel, Roatán, Costa Maya. Starting price $649.",
};

function makeReq(body: unknown): Request {
  return new Request("https://rag.test/api/ingest/itinerary", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  dbCalls.length = 0;
  embedCalls.length = 0;
  existingItinerary = null;
  currentCtx = { scope: "write", service_identifier: "platform-admin", user_id: null, tenant_id: null };
});
afterEach(() => { vi.clearAllMocks(); });

describe("POST /api/ingest/itinerary", () => {
  it("rejects non-platform-admin with 403", async () => {
    currentCtx.service_identifier = "tenant-app";
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(403);
  });

  it("rejects non-write scope with 403", async () => {
    currentCtx.scope = "read";
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(403);
  });

  it("rejects malformed payload with 400", async () => {
    const res = await POST(makeReq({ cruise_line: "RCL" })); // missing required fields
    expect(res.status).toBe(400);
  });

  it("quarantines text containing SSN with 422", async () => {
    const piiText = VALID_BODY.text + " SSN: 123-45-6789 (this should never appear).";
    const res = await POST(makeReq({ ...VALID_BODY, text: piiText }));
    expect(res.status).toBe(422);
    expect(embedCalls).toHaveLength(0); // never embedded
  });

  it("ingests fresh itinerary: embeds, inserts chunk, upserts itinerary", async () => {
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe("ingested");
    expect(embedCalls).toHaveLength(1);
    expect(dbCalls.some((c) => c.table === "knowledge_chunks" && c.op === "insert")).toBe(true);
    expect(dbCalls.some((c) => c.table === "itineraries" && c.op === "upsert")).toBe(true);
  });

  it("short-circuits on unchanged content_hash: no embed, no chunk write", async () => {
    // Compute the actual hash for the body's text.
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(VALID_BODY.text).digest("hex");
    existingItinerary = { id: "existing-id", content_hash: hash, related_chunk_id: "existing-chunk-id" };

    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; itinerary_id: string; chunk_id: string };
    expect(json.status).toBe("unchanged");
    expect(json.itinerary_id).toBe("existing-id");
    expect(json.chunk_id).toBe("existing-chunk-id");

    expect(embedCalls).toHaveLength(0);
    expect(dbCalls.some((c) => c.op === "insert" || c.op === "update" || c.op === "upsert")).toBe(false);
  });

  it("updates in place when content_hash changes", async () => {
    existingItinerary = { id: "existing-id", content_hash: "OLDHASH", related_chunk_id: "existing-chunk-id" };
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe("updated");
    expect(embedCalls).toHaveLength(1);
    expect(dbCalls.some((c) => c.table === "knowledge_chunks" && c.op === "update")).toBe(true);
    expect(dbCalls.some((c) => c.table === "itineraries" && c.op === "upsert")).toBe(true);
  });
});
