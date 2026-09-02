// Seeded-DB companion coverage for mocked retrieval scope unit tests.
//
// The unit tests pin the route's PostgREST predicates and defense-in-depth
// filters. These tests prove those predicates against real RAG tables with
// global, same-tenant, and other-tenant rows.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { assertIsolationQuery } from "../../../../tests/helpers/isolation-witness";
import { fetchApprovedChunksByIds } from "../../src/app/api/retrieve/route";

const ragDbUrl = process.env.SUPABASE_RAG_DB_URL;
if (process.env.RAG_SCOPE_DB_REQUIRED === "true" && !ragDbUrl) {
  throw new Error("SUPABASE_RAG_DB_URL is required for critical RAG isolation coverage");
}
const tenantA = randomUUID();
const tenantB = randomUUID();
const chunkGlobal = randomUUID();
const chunkA = randomUUID();
const chunkB = randomUUID();
const assetGlobal = randomUUID();
const assetA = randomUUID();
const assetB = randomUUID();
const runId = randomUUID().slice(0, 8);
const ship = `Scope Ship ${runId}`;
const port = `Scope Port ${runId}`;
const region = `Scope Region ${runId}`;
const sailDate = "2098-04-12";
const unitEmbedding = `[1,${Array(1535).fill(0).join(",")}]`;

let sql: ReturnType<typeof postgres>;

function productionChunkDb() {
  return {
    from: (table: string) => {
      if (table !== "knowledge_chunks") throw new Error(`unexpected production table: ${table}`);
      let ids: string[] = [];
      let tenantId: string | undefined;
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "is", "not"]) builder[method] = () => builder;
      builder.in = (_column: string, values: string[]) => {
        ids = values;
        return builder;
      };
      builder.or = (filter: string) => {
        tenantId = /(?:^|,)tenant_id\.eq\.([^,]+)/.exec(filter)?.[1];
        return builder;
      };
      builder.then = async (resolve: (result: { data: unknown[]; error: null }) => unknown) => {
        const rows = tenantId
          ? await sql<{ id: string }[]>`
              SELECT * FROM public.knowledge_chunks
              WHERE id IN ${sql(ids)}
                AND status = 'approved'
                AND superseded_by_chunk_id IS NULL
                AND embedding IS NOT NULL
                AND sell_by_at IS NULL
                AND (scope = 'global' OR tenant_id = ${tenantId})
            `
          : await sql<{ id: string }[]>`
              SELECT * FROM public.knowledge_chunks
              WHERE id IN ${sql(ids)}
                AND status = 'approved'
                AND superseded_by_chunk_id IS NULL
                AND embedding IS NOT NULL
                AND sell_by_at IS NULL
            `;
        return resolve({ data: rows, error: null });
      };
      return builder;
    },
  } as unknown as Parameters<typeof fetchApprovedChunksByIds>[0];
}

describe.skipIf(!ragDbUrl)("seeded RAG retrieval scope", () => {
  beforeAll(async () => {
    sql = postgres(ragDbUrl!, { max: 1 });

    await sql`
      INSERT INTO public.knowledge_chunks
        (id, content, content_hash, embedding, scope, tenant_id, category,
         ship_or_property, source_type, authority_auto, status)
      VALUES
        (${chunkGlobal}, ${`Global scope fixture ${runId}`}, ${`scope-global-${runId}`}, ${unitEmbedding}::extensions.vector,
         'global', NULL, 'ship_intel', ${ship}, 'test', 0.5, 'approved'),
        (${chunkA}, ${`Tenant A scope fixture ${runId}`}, ${`scope-a-${runId}`}, ${unitEmbedding}::extensions.vector,
         'tenant', ${tenantA}, 'ship_intel', ${ship}, 'test', 0.5, 'approved'),
        (${chunkB}, ${`Tenant B scope fixture ${runId}`}, ${`scope-b-${runId}`}, ${unitEmbedding}::extensions.vector,
         'tenant', ${tenantB}, 'ship_intel', ${ship}, 'test', 0.5, 'approved')
    `;

    await sql`
      INSERT INTO public.rag_media_assets
        (asset_id, kind, entity_type, entity_id, scope, tenant_id, image_url,
         source_page_url, attribution, source)
      VALUES
        (${assetGlobal}, 'ship_photo', 'ship', ${`global-${runId}`}, 'global', NULL,
         ${`https://example.com/${runId}/global.jpg`}, 'https://example.com/source', 'Test fixture', 'test'),
        (${assetA}, 'ship_photo', 'ship', ${`tenant-a-${runId}`}, 'tenant', ${tenantA},
         ${`https://example.com/${runId}/tenant-a.jpg`}, 'https://example.com/source', 'Test fixture', 'test'),
        (${assetB}, 'ship_photo', 'ship', ${`tenant-b-${runId}`}, 'tenant', ${tenantB},
         ${`https://example.com/${runId}/tenant-b.jpg`}, 'https://example.com/source', 'Test fixture', 'test')
    `;

    await sql`
      INSERT INTO public.itineraries
        (id, cruise_line, ship, departure_date, departure_port, duration_nights,
         ports_of_call, region, content_hash, related_chunk_id)
      VALUES
        (${randomUUID()}, ${`Global Line ${runId}`}, ${ship}, ${sailDate}, ${port}, 7,
         ${[port]}, ${region}, ${`itinerary-global-${runId}`}, ${chunkGlobal}),
        (${randomUUID()}, ${`Tenant A Line ${runId}`}, ${ship}, ${sailDate}, ${port}, 7,
         ${[port]}, ${region}, ${`itinerary-a-${runId}`}, ${chunkA}),
        (${randomUUID()}, ${`Tenant B Line ${runId}`}, ${ship}, ${sailDate}, ${port}, 7,
         ${[port]}, ${region}, ${`itinerary-b-${runId}`}, ${chunkB})
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM public.itineraries WHERE related_chunk_id IN (${chunkGlobal}, ${chunkA}, ${chunkB})`;
    await sql`DELETE FROM public.rag_media_assets WHERE asset_id IN (${assetGlobal}, ${assetA}, ${assetB})`;
    await sql`DELETE FROM public.knowledge_chunks WHERE id IN (${chunkGlobal}, ${chunkA}, ${chunkB})`;
    await sql.end();
  });

  it("asset hydration scope returns global and tenant A assets, not tenant B", async () => {
    await assertIsolationQuery({
      query: () => sql<{ id: string }[]>`
        SELECT asset_id AS id
        FROM public.rag_media_assets
        WHERE asset_id IN (${assetGlobal}, ${assetA}, ${assetB})
          AND (scope = 'global' OR tenant_id = ${tenantA})
      `,
      allowedIds: [assetGlobal, assetA],
      deniedIds: [assetB],
    });
  });

  it("chunk hydration scope returns global and tenant A chunks, not tenant B", async () => {
    await assertIsolationQuery({
      query: () => sql<{ id: string }[]>`
        SELECT id
        FROM public.knowledge_chunks
        WHERE id IN (${chunkGlobal}, ${chunkA}, ${chunkB})
          AND (scope = 'global' OR tenant_id = ${tenantA})
      `,
      allowedIds: [chunkGlobal, chunkA],
      deniedIds: [chunkB],
    });
  });

  it("production approved-chunk retrieval returns global and tenant A chunks, not tenant B", async () => {
    await assertIsolationQuery({
      query: () => fetchApprovedChunksByIds(productionChunkDb(), tenantA, [chunkGlobal, chunkA, chunkB]) as Promise<Array<{ id: string }>>,
      allowedIds: [chunkGlobal, chunkA],
      deniedIds: [chunkB],
    });
  });

  it("relocated vector RPC returns global and tenant A chunks, not tenant B", async () => {
    await assertIsolationQuery({
      query: () => sql<{ id: string }[]>`
        SELECT id
        FROM public.match_knowledge_chunks(
          ${unitEmbedding}::extensions.vector,
          ${tenantA}::uuid,
          12
        )
      `,
      allowedIds: [chunkGlobal, chunkA],
      deniedIds: [chunkB],
    });
  });

  it("keeps relocated extension indexes valid and ready", async () => {
    const extensionSchemas = await sql<{ extname: string; schema: string }[]>`
      SELECT e.extname, n.nspname AS schema
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname IN ('vector', 'pg_trgm')
      ORDER BY e.extname
    `;
    expect(extensionSchemas).toEqual([
      { extname: "pg_trgm", schema: "extensions" },
      { extname: "vector", schema: "extensions" },
    ]);

    const indexes = await sql<{ name: string; valid: boolean; ready: boolean }[]>`
      SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname IN (
        'idx_itineraries_ship_trgm',
        'idx_itineraries_departure_port_trgm',
        'idx_knowledge_chunks_ship_or_property_trgm',
        'knowledge_chunks_embedding_hnsw_idx'
      )
      ORDER BY c.relname
    `;
    expect(indexes).toEqual([
      { name: "idx_itineraries_departure_port_trgm", valid: true, ready: true },
      { name: "idx_itineraries_ship_trgm", valid: true, ready: true },
      { name: "idx_knowledge_chunks_ship_or_property_trgm", valid: true, ready: true },
      { name: "knowledge_chunks_embedding_hnsw_idx", valid: true, ready: true },
    ]);
  });

  it("itinerary lookup scope returns global and tenant A chunks, not tenant B", async () => {
    await assertIsolationQuery({
      query: () => sql<{ id: string }[]>`
        SELECT kc.id
        FROM public.itineraries i
        JOIN public.knowledge_chunks kc ON kc.id = i.related_chunk_id
        WHERE i.ship ILIKE ${`%${ship}%`}
          AND i.departure_date = ${sailDate}
          AND (kc.scope = 'global' OR kc.tenant_id = ${tenantA})
      `,
      allowedIds: [chunkGlobal, chunkA],
      deniedIds: [chunkB],
    });
  });

  it("ship lookup scope returns global and tenant A chunks, not tenant B", async () => {
    await assertIsolationQuery({
      query: () => sql<{ id: string }[]>`
        SELECT id
        FROM public.knowledge_chunks
        WHERE ship_or_property ILIKE ${`%${ship}%`}
          AND category IN ('deck_intel', 'ship_intel')
          AND status = 'approved'
          AND superseded_by_chunk_id IS NULL
          AND embedding IS NOT NULL
          AND sell_by_at IS NULL
          AND (scope = 'global' OR tenant_id = ${tenantA})
      `,
      allowedIds: [chunkGlobal, chunkA],
      deniedIds: [chunkB],
    });
  });

  it("port lookup scope returns global and tenant A chunks, not tenant B", async () => {
    await assertIsolationQuery({
      query: () => sql<{ id: string }[]>`
        SELECT kc.id
        FROM public.itineraries i
        JOIN public.knowledge_chunks kc ON kc.id = i.related_chunk_id
        WHERE i.departure_port ILIKE ${`%${port}%`}
          AND i.departure_date = ${sailDate}
          AND (kc.scope = 'global' OR kc.tenant_id = ${tenantA})
      `,
      allowedIds: [chunkGlobal, chunkA],
      deniedIds: [chunkB],
    });
  });

  it("region lookup scope returns global and tenant A chunks, not tenant B", async () => {
    await assertIsolationQuery({
      query: () => sql<{ id: string }[]>`
        SELECT kc.id
        FROM public.match_region_itinerary_chunks(
          ARRAY[${region}]::text[], ARRAY[]::text[], ${sailDate}::date,
          ${sailDate}::date, ARRAY[]::text[], 12
        ) matched
        JOIN public.knowledge_chunks kc ON kc.id = matched.related_chunk_id
        WHERE kc.scope = 'global' OR kc.tenant_id = ${tenantA}
      `,
      allowedIds: [chunkGlobal, chunkA],
      deniedIds: [chunkB],
    });
  });
});
