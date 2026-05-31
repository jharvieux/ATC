// BP35 §33.4 — POST /api/ingest/itinerary
//
// Trusted batch reference ingest for CruiseMapper itineraries. Bypasses
// the human-review queue (these are reference-data records from a known
// source, not user-submitted content). Caller must be platform-admin.
//
// Idempotency contract:
//   - UNIQUE (cruise_line, ship, departure_date, departure_port) on the
//     itineraries table.
//   - If an existing row has the same content_hash, skip the embedding +
//     chunk write entirely (zero-cost no-op on duplicate ingest).
//   - Otherwise re-embed and update the related knowledge_chunks row in
//     place by content_hash match.
//
// Authority + category: per BP35 spec — authority=0.45 (mid-`low` tier
// §6.3), category='itinerary', scope='global', source='cruisemapper.com'.

export const dynamic = "force-dynamic";

import { createHash } from "node:crypto";
import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";
import { embed } from "@/lib/embeddings/openai";
import { detectZeroTolerancePII } from "@/lib/pii/regex-prefilter";
import { ItineraryIngestRequestSchema } from "@/lib/schemas/itinerary-ingest";

interface IngestOutcome {
  status: "ingested" | "updated" | "unchanged" | "quarantined";
  itinerary_id?: string;
  chunk_id?: string | null;
  reason?: string;
}

export const POST = withServiceAuth(async (req, ctx) => {
  if (ctx.scope !== "write") {
    return Response.json({ error: "insufficient_scope" }, { status: 403 });
  }
  if (ctx.service_identifier !== "platform-admin") {
    return Response.json({ error: "itinerary_ingest_requires_platform_admin" }, { status: 403 });
  }

  let body: ReturnType<typeof ItineraryIngestRequestSchema.parse>;
  try {
    const raw = await req.json();
    body = ItineraryIngestRequestSchema.parse(raw);
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // PII screen — itinerary text shouldn't contain PII, but the actor is
  // untrusted input. Same zero-tolerance gate as /api/ingest.
  const pii = detectZeroTolerancePII(body.text);
  if (pii.detected) {
    const outcome: IngestOutcome = {
      status: "quarantined",
      reason: `zero_tolerance_pii_detected: ${pii.categories.join(", ")}`,
    };
    return Response.json(outcome, { status: 422 });
  }

  const contentHash = createHash("sha256").update(body.text).digest("hex");
  const db = getRagDb();

  // 1. Look up existing itinerary by composite key.
  const { data: existing, error: existingErr } = await db
    .from("itineraries")
    .select("id, content_hash, related_chunk_id")
    .eq("cruise_line", body.cruise_line)
    .eq("ship", body.ship)
    .eq("departure_date", body.departure_date)
    .eq("departure_port", body.departure_port)
    .maybeSingle();
  if (existingErr) {
    console.error("[ingest/itinerary] itineraries lookup failed:", existingErr);
    return Response.json({ error: "db_lookup_failed" }, { status: 500 });
  }

  const existingRow = existing as { id: string; content_hash: string; related_chunk_id: string | null } | null;

  // 2. If unchanged, no-op.
  if (existingRow && existingRow.content_hash === contentHash) {
    const outcome: IngestOutcome = {
      status: "unchanged",
      itinerary_id: existingRow.id,
      chunk_id: existingRow.related_chunk_id,
    };
    return Response.json(outcome);
  }

  // 3. Embed.
  let embedding: number[];
  try {
    embedding = await embed(body.text);
  } catch (err) {
    console.error("[ingest/itinerary] embedding failed:", err);
    return Response.json({ error: "embedding_failed" }, { status: 500 });
  }

  const fetchedAtIso = body.fetched_at ?? new Date().toISOString();
  const sourceUrl = body.source_url ?? null;

  // DIY sailing data (has day_by_day) gets authority by content type:
  //   price-containing → 0.40, reference-only → 0.55.
  // Legacy Apify path (day_by_day absent) keeps the original 0.45.
  const containsPricing = typeof body.starting_price_usd === "number";
  const authorityAuto = body.day_by_day != null
    ? (containsPricing ? 0.40 : 0.55)
    : 0.45;

  // 4. Upsert knowledge_chunks row.
  //    On UPDATE we replace content, embedding, content_hash, and authority
  //    for the matching chunk. On INSERT we link from itineraries.related_chunk_id.
  let chunkId: string;
  if (existingRow?.related_chunk_id) {
    const { data: updated, error: updErr } = await db
      .from("knowledge_chunks")
      .update({
        content: body.text,
        content_hash: contentHash,
        embedding: `[${embedding.join(",")}]`,
        category: "itinerary",
        cruise_line_or_supplier: body.cruise_line,
        ship_or_property: body.ship,
        destination: body.region ?? null,
        source_url: sourceUrl,
        authority_auto: authorityAuto,
        contains_pricing: containsPricing,
        ingested_at: fetchedAtIso,
        status: "approved",
      })
      .eq("id", existingRow.related_chunk_id)
      .select("id")
      .single();
    if (updErr || !updated) {
      console.error("[ingest/itinerary] chunk update failed:", updErr);
      return Response.json({ error: "chunk_update_failed" }, { status: 500 });
    }
    chunkId = updated.id as string;
  } else {
    const { data: inserted, error: insErr } = await db
      .from("knowledge_chunks")
      .insert({
        content: body.text,
        content_hash: contentHash,
        embedding: `[${embedding.join(",")}]`,
        scope: "global",
        tenant_id: null,
        category: "itinerary",
        cruise_line_or_supplier: body.cruise_line,
        ship_or_property: body.ship,
        destination: body.region ?? null,
        source_type: "cruisemapper_itinerary",
        source_url: sourceUrl,
        source_domain: "cruisemapper.com",
        authority_auto: authorityAuto,
        contains_pricing: containsPricing,
        status: "approved",
        ingested_at: fetchedAtIso,
        approved_at: fetchedAtIso,
      })
      .select("id")
      .single();
    if (insErr || !inserted) {
      console.error("[ingest/itinerary] chunk insert failed:", insErr);
      return Response.json({ error: "chunk_insert_failed" }, { status: 500 });
    }
    chunkId = inserted.id as string;
  }

  // 5. Upsert the itineraries row.
  const { data: itin, error: itinErr } = await db
    .from("itineraries")
    .upsert(
      {
        cruise_line: body.cruise_line,
        ship: body.ship,
        departure_date: body.departure_date,
        departure_port: body.departure_port,
        duration_nights: body.duration_nights,
        ports_of_call: body.ports_of_call,
        region: body.region ?? null,
        starting_price_usd: body.starting_price_usd ?? null,
        day_by_day: body.day_by_day ?? null,
        source_url: sourceUrl,
        content_hash: contentHash,
        related_chunk_id: chunkId,
        fetched_at: fetchedAtIso,
      },
      { onConflict: "cruise_line,ship,departure_date,departure_port" },
    )
    .select("id")
    .single();

  if (itinErr || !itin) {
    console.error("[ingest/itinerary] itinerary upsert failed:", itinErr);
    return Response.json({ error: "itinerary_upsert_failed" }, { status: 500 });
  }

  const outcome: IngestOutcome = {
    status: existingRow ? "updated" : "ingested",
    itinerary_id: itin.id as string,
    chunk_id: chunkId,
  };
  return Response.json(outcome);
});
