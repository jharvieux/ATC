// BP35 §33.4 — Monthly CruiseMapper itinerary refresh.
//
// Cron: 1st of every month at 03:00 UTC.
//
// Flow:
//   1. Guard fence — CRUISEMAPPER_ITINERARY_INGEST_ENABLED + Apify token +
//      monthly budget cap. All checks live inside runCruiseMapperItineraryActor.
//   2. Actor dispatch → raw itinerary items.
//   3. Map each item to (CachedPriceQuote?, RAG text doc).
//   4. Upsert each present cacheQuote into pricing_cache.
//   5. POST each itinerary to RAG /api/ingest/itinerary. The endpoint
//      writes the itineraries row + the knowledge_chunks row (idempotent
//      via composite UNIQUE + content_hash short-circuit).
//
// All counts are logged in the returned struct for observability.

import { inngest } from "./client";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { runCruiseMapperItineraryActor } from "@/lib/external/cruisemapper/cruisemapper-actor";
import { mapItinerary, type CruiseMapperItineraryItem } from "@/lib/external/cruisemapper/itinerary-mapper";
import { upsertPriceQuote } from "@/lib/pricing/pricing-cache";
import { ingestItineraryToRag } from "@/lib/external/cruisemapper/rag-itinerary-ingest";

export const refreshCruisemapperItineraries = inngest.createFunction(
  {
    id: "refresh-cruisemapper-itineraries",
    triggers: [{ cron: "0 3 1 * *" }], // 03:00 UTC on the 1st of every month
  },
  async () => {
    if (process.env.STAGING_MODE === "true") return { skipped_for_staging: true };

    return withPlatformAdminAudit(
      {
        admin_user_id: "system-cron",
        reason: "external_pricing_refresh",
        operation: "refresh_cruisemapper_itineraries",
      },
      async (db, recordQuery) => {
        const actor = await runCruiseMapperItineraryActor(db);
        recordQuery({ op: "insert", table: "apify_spend_ledger" });

        if (actor.status !== "succeeded") {
          return {
            status: actor.status,
            reason: actor.reason ?? null,
            items_received: 0,
            items_mapped: 0,
            cache_written: 0,
            rag_ingested: 0,
            rag_updated: 0,
            rag_unchanged: 0,
            rag_quarantined: 0,
            rag_errors: 0,
            spend_usd: actor.spend_usd,
          };
        }

        let itemsMapped = 0;
        let cacheWritten = 0;
        let ragIngested = 0;
        let ragUpdated = 0;
        let ragUnchanged = 0;
        let ragQuarantined = 0;
        let ragErrors = 0;
        const errorSamples: Array<{ key: string; reason?: string }> = [];

        for (const raw of actor.items) {
          const mapped = mapItinerary(raw as CruiseMapperItineraryItem);
          if (!mapped) continue;
          itemsMapped += 1;

          if (mapped.cacheQuote) {
            try {
              await upsertPriceQuote(db, mapped.cacheQuote);
              cacheWritten += 1;
            } catch {
              // Cache write failures don't block RAG ingest — chunk text
              // is still useful even when the price didn't land in cache.
            }
          }

          const outcome = await ingestItineraryToRag(mapped);
          switch (outcome.status) {
            case "ingested":   ragIngested += 1; break;
            case "updated":    ragUpdated += 1; break;
            case "unchanged":  ragUnchanged += 1; break;
            case "quarantined": ragQuarantined += 1; break;
            default:
              ragErrors += 1;
              if (errorSamples.length < 10) {
                const sample: { key: string; reason?: string } = {
                  key: `${mapped.key.line}:${mapped.key.ship}:${mapped.key.sailDate}`,
                };
                if (outcome.reason) sample.reason = outcome.reason;
                errorSamples.push(sample);
              }
          }
        }

        return {
          status: "succeeded",
          items_received: actor.items.length,
          items_mapped: itemsMapped,
          cache_written: cacheWritten,
          rag_ingested: ragIngested,
          rag_updated: ragUpdated,
          rag_unchanged: ragUnchanged,
          rag_quarantined: ragQuarantined,
          rag_errors: ragErrors,
          spend_usd: actor.spend_usd,
          actor_run_id: actor.actor_run_id,
          ...(errorSamples.length ? { error_samples: errorSamples } : {}),
        };
      },
    );
  },
);
