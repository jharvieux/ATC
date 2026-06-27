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

const RUN_ID = randomUUID().slice(0, 8);

// Chunk IDs — seeded into knowledge_chunks so itineraries FK resolves.
const CHUNK_AU = randomUUID();
const CHUNK_CA = randomUUID();
const CHUNK_IT = randomUUID();

// Pre-compute all string values so they are passed as parameters,
// not embedded in SQL string literals where $N markers are literal text.
const KC_CONTENT_AU = `AU fixture ${RUN_ID}`;
const KC_CONTENT_CA = `CA fixture ${RUN_ID}`;
const KC_CONTENT_IT = `IT fixture ${RUN_ID}`;
const KC_HASH_AU = `kc-au-${CHUNK_AU}`;
const KC_HASH_CA = `kc-ca-${CHUNK_CA}`;
const KC_HASH_IT = `kc-it-${CHUNK_IT}`;

const ITIN_CRUISE_AU = `Line A ${RUN_ID}`;
const ITIN_CRUISE_CA = `Line B ${RUN_ID}`;
const ITIN_CRUISE_IT = `Line C ${RUN_ID}`;
const ITIN_HASH_AU = `it-au-${CHUNK_AU}`;
const ITIN_HASH_CA = `it-ca-${CHUNK_CA}`;
const ITIN_HASH_IT = `it-it-${CHUNK_IT}`;

const DEPART_AU = "Sydney, NSW Australia";
const DEPART_CA = "Sydney NS, Nova Scotia Canada";
const DEPART_IT = "Civitavecchia-Rome";
const PORTS_AU = [DEPART_AU, "Melbourne, Victoria Australia"];
const PORTS_CA = [DEPART_CA, "Halifax, Nova Scotia Canada"];
const PORTS_IT = [DEPART_IT, "Naples, Italy"];

interface Fixtures {
  sql: ReturnType<typeof postgres>;
}

let f!: Fixtures;

describeIf("match_region_itinerary_chunks — segment-exact port matching (#1470)", () => {
  beforeAll(async () => {
    const sql = postgres(ragDbUrl!, { max: 1 });
    f = { sql };

    await sql`
      INSERT INTO public.knowledge_chunks
        (id, content, content_hash, scope, category, source_type, authority_auto, status)
      VALUES
        (${CHUNK_AU}, ${KC_CONTENT_AU}, ${KC_HASH_AU}, 'global', 'general', 'itinerary', 0.5, 'approved'),
        (${CHUNK_CA}, ${KC_CONTENT_CA}, ${KC_HASH_CA}, 'global', 'general', 'itinerary', 0.5, 'approved'),
        (${CHUNK_IT}, ${KC_CONTENT_IT}, ${KC_HASH_IT}, 'global', 'general', 'itinerary', 0.5, 'approved')
    `;

    // Seed itinerary rows. ports_of_call content drives segment matching.
    // UNIQUE constraint: (cruise_line, ship, departure_date, departure_port).
    await sql`
      INSERT INTO public.itineraries
        (id, cruise_line, ship, departure_port, ports_of_call,
         departure_date, duration_nights, content_hash, related_chunk_id, source_url)
      VALUES
        (${randomUUID()}, ${ITIN_CRUISE_AU}, 'Ship AU', ${DEPART_AU},
         ${PORTS_AU}, '2027-03-04', 10, ${ITIN_HASH_AU}, ${CHUNK_AU}, 'https://example.com/au'),
        (${randomUUID()}, ${ITIN_CRUISE_CA}, 'Ship CA', ${DEPART_CA},
         ${PORTS_CA}, '2027-03-10', 7, ${ITIN_HASH_CA}, ${CHUNK_CA}, 'https://example.com/ca'),
        (${randomUUID()}, ${ITIN_CRUISE_IT}, 'Ship IT', ${DEPART_IT},
         ${PORTS_IT}, '2027-04-01', 9, ${ITIN_HASH_IT}, ${CHUNK_IT}, 'https://example.com/it')
    `;
  });

  afterAll(async () => {
    if (!f) return;
    // Delete in FK order: itineraries → knowledge_chunks.
    await f.sql`DELETE FROM public.itineraries WHERE related_chunk_id IN (${CHUNK_AU}, ${CHUNK_CA}, ${CHUNK_IT})`;
    await f.sql`DELETE FROM public.knowledge_chunks WHERE id IN (${CHUNK_AU}, ${CHUNK_CA}, ${CHUNK_IT})`;
    await f.sql.end();
  });

  it("returns Australian Sydney sailing but NOT Nova-Scotia Sydney (segment-exact)", async () => {
    // WHY: the pre-0033 substring ILIKE matched both 'Sydney, NSW Australia' and
    // 'Sydney NS, Nova Scotia Canada'. The segment-exact fix splits on comma/hyphen,
    // so 'Sydney NS' is the segment — no match for search term 'Sydney'.
    const rows = await f.sql<{ related_chunk_id: string }[]>`
      SELECT related_chunk_id FROM public.match_region_itinerary_chunks(
        p_region_terms      => ARRAY['Australia']::text[],
        p_port_terms        => ARRAY['Sydney']::text[],
        p_date_from         => '2027-01-01'::date,
        p_date_to           => '2027-12-31'::date,
        p_origin_port_terms => ARRAY[]::text[],
        p_limit             => 50
      )
    `;
    const ids = rows.map((r) => r.related_chunk_id);
    expect(ids).toContain(CHUNK_AU);
    expect(ids).not.toContain(CHUNK_CA);
  });

  it("matches 'Rome' against hyphenated port 'Civitavecchia-Rome'", async () => {
    // WHY: hyphen is a segment delimiter alongside comma, so 'Civitavecchia-Rome'
    // yields segments ['Civitavecchia', 'Rome']. 'Rome' matches exactly — verifies
    // that hyphen-split recall is preserved by 0033.
    const rows = await f.sql<{ related_chunk_id: string }[]>`
      SELECT related_chunk_id FROM public.match_region_itinerary_chunks(
        p_region_terms      => ARRAY['Italy']::text[],
        p_port_terms        => ARRAY['Rome']::text[],
        p_date_from         => '2027-01-01'::date,
        p_date_to           => '2027-12-31'::date,
        p_origin_port_terms => ARRAY[]::text[],
        p_limit             => 50
      )
    `;
    const ids = rows.map((r) => r.related_chunk_id);
    expect(ids).toContain(CHUNK_IT);
  });
});
