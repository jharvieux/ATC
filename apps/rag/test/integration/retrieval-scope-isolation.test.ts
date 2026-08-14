// Seeded-DB companion coverage for mocked retrieval scope unit tests.
//
// The unit tests pin the route's PostgREST predicates and defense-in-depth
// filters. These tests prove those predicates against real RAG tables with
// global, same-tenant, and other-tenant rows.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const ragDbUrl = process.env.SUPABASE_RAG_DB_URL;
const describeIf = ragDbUrl ? describe : describe.skip;

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
const zeroEmbedding = `[${Array(1536).fill(0).join(",")}]`;

let sql: ReturnType<typeof postgres>;

function ids(rows: Array<{ id: string }>): string[] {
  return rows.map((row) => row.id).sort();
}

describeIf("seeded RAG retrieval scope", () => {
  beforeAll(async () => {
    sql = postgres(ragDbUrl!, { max: 1 });

    await sql`
      INSERT INTO public.knowledge_chunks
        (id, content, content_hash, embedding, scope, tenant_id, category,
         ship_or_property, source_type, authority_auto, status)
      VALUES
        (${chunkGlobal}, ${`Global scope fixture ${runId}`}, ${`scope-global-${runId}`}, ${zeroEmbedding}::vector,
         'global', NULL, 'ship_intel', ${ship}, 'test', 0.5, 'approved'),
        (${chunkA}, ${`Tenant A scope fixture ${runId}`}, ${`scope-a-${runId}`}, ${zeroEmbedding}::vector,
         'tenant', ${tenantA}, 'ship_intel', ${ship}, 'test', 0.5, 'approved'),
        (${chunkB}, ${`Tenant B scope fixture ${runId}`}, ${`scope-b-${runId}`}, ${zeroEmbedding}::vector,
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
    const rows = await sql<{ id: string }[]>`
      SELECT asset_id AS id
      FROM public.rag_media_assets
      WHERE asset_id IN (${assetGlobal}, ${assetA}, ${assetB})
        AND (scope = 'global' OR tenant_id = ${tenantA})
    `;
    expect(ids(rows)).toEqual([assetGlobal, assetA].sort());
  });

  it("chunk hydration scope returns global and tenant A chunks, not tenant B", async () => {
    const rows = await sql<{ id: string }[]>`
      SELECT id
      FROM public.knowledge_chunks
      WHERE id IN (${chunkGlobal}, ${chunkA}, ${chunkB})
        AND (scope = 'global' OR tenant_id = ${tenantA})
    `;
    expect(ids(rows)).toEqual([chunkGlobal, chunkA].sort());
  });

  it("itinerary lookup scope returns global and tenant A chunks, not tenant B", async () => {
    const rows = await sql<{ id: string }[]>`
      SELECT kc.id
      FROM public.itineraries i
      JOIN public.knowledge_chunks kc ON kc.id = i.related_chunk_id
      WHERE i.ship ILIKE ${`%${ship}%`}
        AND i.departure_date = ${sailDate}
        AND (kc.scope = 'global' OR kc.tenant_id = ${tenantA})
    `;
    expect(ids(rows)).toEqual([chunkGlobal, chunkA].sort());
  });

  it("ship lookup scope returns global and tenant A chunks, not tenant B", async () => {
    const rows = await sql<{ id: string }[]>`
      SELECT id
      FROM public.knowledge_chunks
      WHERE ship_or_property ILIKE ${`%${ship}%`}
        AND category IN ('deck_intel', 'ship_intel')
        AND status = 'approved'
        AND superseded_by_chunk_id IS NULL
        AND embedding IS NOT NULL
        AND sell_by_at IS NULL
        AND (scope = 'global' OR tenant_id = ${tenantA})
    `;
    expect(ids(rows)).toEqual([chunkGlobal, chunkA].sort());
  });

  it("port lookup scope returns global and tenant A chunks, not tenant B", async () => {
    const rows = await sql<{ id: string }[]>`
      SELECT kc.id
      FROM public.itineraries i
      JOIN public.knowledge_chunks kc ON kc.id = i.related_chunk_id
      WHERE i.departure_port ILIKE ${`%${port}%`}
        AND i.departure_date = ${sailDate}
        AND (kc.scope = 'global' OR kc.tenant_id = ${tenantA})
    `;
    expect(ids(rows)).toEqual([chunkGlobal, chunkA].sort());
  });

  it("region lookup scope returns global and tenant A chunks, not tenant B", async () => {
    const rows = await sql<{ id: string }[]>`
      SELECT kc.id
      FROM public.match_region_itinerary_chunks(
        ARRAY[${region}]::text[], ARRAY[]::text[], ${sailDate}::date,
        ${sailDate}::date, ARRAY[]::text[], 12
      ) matched
      JOIN public.knowledge_chunks kc ON kc.id = matched.related_chunk_id
      WHERE kc.scope = 'global' OR kc.tenant_id = ${tenantA}
    `;
    expect(ids(rows)).toEqual([chunkGlobal, chunkA].sort());
  });
});
