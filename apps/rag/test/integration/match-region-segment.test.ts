// DB integration test — segment-exact port matching in match_region_itinerary_chunks.
// Issue: #1470
// Migration: 0033_region_itinerary_segment_match.sql
//
// WHY: unit tests mock db.rpc() entirely and cannot catch SQL regression.
// A future migration that re-introduced substring ILIKE matching would allow
// the Sydney/Nova-Scotia collision (#1466) to reappear silently.
// This test hits the live DB and asserts segment-exact behaviour directly.
//
// Requires a live RAG Supabase project. Gated on SUPABASE_RAG_DB_URL;
// skipped in PR CI, runs in the nightly DB job.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const ragDbUrl = process.env.SUPABASE_RAG_DB_URL;
const haveRagDb = Boolean(ragDbUrl);
const describeIf = haveRagDb ? describe : describe.skip;

// Unique tag scopes all fixture rows to this run; afterAll deletes by tag.
const RUN_TAG = `seg-${randomUUID().slice(0, 8)}`;

// Fake chunk IDs — must exist in knowledge_chunks for the FK. We insert them
// as minimal rows and delete after. Scope is "global" to satisfy the NOT NULL
// scope check without needing a tenant.
const CHUNK_AU = randomUUID();
const CHUNK_CA = randomUUID();
const CHUNK_IT = randomUUID();

interface Fixtures {
  sql: ReturnType<typeof postgres>;
}

let f: Fixtures;

describeIf("match_region_itinerary_chunks — segment-exact port matching (#1470)", () => {
  beforeAll(async () => {
    const sql = postgres(ragDbUrl!, { max: 1 });
    f = { sql };

    // Seed minimal knowledge_chunks rows so itineraries FK resolves.
    await sql`
      INSERT INTO public.knowledge_chunks (id, content, content_hash, scope, category, status)
      VALUES
        (${CHUNK_AU}, 'AU fixture ${RUN_TAG}', md5('AU${RUN_TAG}'), 'global', 'general', 'approved'),
        (${CHUNK_CA}, 'CA fixture ${RUN_TAG}', md5('CA${RUN_TAG}'), 'global', 'general', 'approved'),
        (${CHUNK_IT}, 'IT fixture ${RUN_TAG}', md5('IT${RUN_TAG}'), 'global', 'general', 'approved')
    `;

    // Seed itinerary rows. ports_of_call drives segment matching.
    await sql`
      INSERT INTO public.itineraries
        (id, ship_name, departure_port, ports_of_call, departure_date, return_date,
         duration_nights, related_chunk_id, source_url)
      VALUES
        (${randomUUID()}, 'Ship A ${RUN_TAG}', 'Sydney, NSW Australia',
         ARRAY['Sydney, NSW Australia', 'Melbourne, Victoria Australia'],
         '2027-03-04', '2027-03-14', 10, ${CHUNK_AU}, 'https://example.com/au'),
        (${randomUUID()}, 'Ship B ${RUN_TAG}', 'Sydney NS, Nova Scotia Canada',
         ARRAY['Sydney NS, Nova Scotia Canada', 'Halifax, Nova Scotia Canada'],
         '2027-03-10', '2027-03-17', 7, ${CHUNK_CA}, 'https://example.com/ca'),
        (${randomUUID()}, 'Ship C ${RUN_TAG}', 'Civitavecchia-Rome',
         ARRAY['Civitavecchia-Rome', 'Naples, Italy'],
         '2027-04-01', '2027-04-10', 9, ${CHUNK_IT}, 'https://example.com/it')
    `;
  });

  afterAll(async () => {
    if (!f) return;
    // Delete in FK order: itineraries → knowledge_chunks.
    await f.sql`
      DELETE FROM public.itineraries WHERE related_chunk_id IN (${CHUNK_AU}, ${CHUNK_CA}, ${CHUNK_IT})
    `;
    await f.sql`
      DELETE FROM public.knowledge_chunks WHERE id IN (${CHUNK_AU}, ${CHUNK_CA}, ${CHUNK_IT})
    `;
    await f.sql.end();
  });

  it("returns Australian Sydney sailing but NOT Nova-Scotia Sydney (segment-exact)", async () => {
    // WHY: the pre-0033 substring ILIKE matched both. The segment-exact fix
    // requires token 'Sydney' to equal a comma/hyphen-delimited segment, so
    // 'Sydney NS, Nova Scotia Canada' produces segment 'Sydney NS' — no match.
    const rows = await f.sql<{ chunk_id: string }[]>`
      SELECT chunk_id FROM public.match_region_itinerary_chunks(
        p_region_terms   => ARRAY['Australia']::text[],
        p_port_terms     => ARRAY['Sydney']::text[],
        p_date_from      => '2027-01-01'::date,
        p_date_to        => '2027-12-31'::date,
        p_origin_port_terms => ARRAY[]::text[],
        p_limit          => 50
      )
    `;
    const ids = rows.map((r) => r.chunk_id);
    expect(ids).toContain(CHUNK_AU);
    expect(ids).not.toContain(CHUNK_CA);
  });

  it("matches 'Rome' against hyphenated port 'Civitavecchia-Rome'", async () => {
    // WHY: hyphen is a segment delimiter, so 'Rome' equals segment 'Rome' from
    // 'Civitavecchia-Rome'. Verifies hyphen-split recall is preserved.
    const rows = await f.sql<{ chunk_id: string }[]>`
      SELECT chunk_id FROM public.match_region_itinerary_chunks(
        p_region_terms   => ARRAY['Italy']::text[],
        p_port_terms     => ARRAY['Rome']::text[],
        p_date_from      => '2027-01-01'::date,
        p_date_to        => '2027-12-31'::date,
        p_origin_port_terms => ARRAY[]::text[],
        p_limit          => 50
      )
    `;
    const ids = rows.map((r) => r.chunk_id);
    expect(ids).toContain(CHUNK_IT);
  });
});
