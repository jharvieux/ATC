// #485 follow-up §33.4 — shared sailing ingest helper.
//
// Called from both refresh-cruisemapper-static (quarterly, reuses the ship-page
// fetch) and refresh-cruisemapper-sailings (monthly, fetches ship pages anew).
// Parses current sailing + upcoming list from already-fetched HTML, maps both
// to MappedItinerary, and ingests to RAG + pricing cache.

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseSailingPage } from "./parsers/sailing-parser";
import { parseSailingList } from "./parsers/sailing-list-parser";
import { mapSailing, mapSailingListItem } from "./itinerary-mapper";
import { ingestItineraryToRag } from "./rag-itinerary-ingest";
import { upsertPriceQuote } from "@/lib/pricing/pricing-cache";

export interface SailingRunResult {
  current_parsed: number;
  current_ingested: number;
  current_errors: number;
  list_items: number;
  list_price_cache_written: number;
  list_ingested: number;
}

export function emptySailingResult(): SailingRunResult {
  return {
    current_parsed: 0,
    current_ingested: 0,
    current_errors: 0,
    list_items: 0,
    list_price_cache_written: 0,
    list_ingested: 0,
  };
}

/**
 * Parse the current sailing + upcoming-sailings list from already-fetched HTML
 * and ingest both to RAG. Price quotes from the list are also written to the
 * main-app pricing cache.
 *
 * Failures here never throw — the caller (ship loop or sailing-only loop) marks
 * them via the result counters and continues.
 */
export async function processSailingHtml(
  db: SupabaseClient,
  html: string,
  shipUrl: string,
  result: SailingRunResult,
): Promise<void> {
  // Current sailing (with full day_by_day).
  const sailing = parseSailingPage(html, shipUrl);
  if (!sailing) {
    result.current_errors += 1;
    return;
  }
  result.current_parsed += 1;

  const mapped = mapSailing(sailing);
  if (mapped) {
    const outcome = await ingestItineraryToRag(mapped);
    if (outcome.status === "ingested" || outcome.status === "updated" || outcome.status === "unchanged") {
      result.current_ingested += 1;
    } else {
      result.current_errors += 1;
    }
  } else {
    result.current_errors += 1;
  }

  // Upcoming sailings list — prices + RAG text, no day_by_day.
  const listItems = parseSailingList(html);
  result.list_items += listItems.length;

  for (const item of listItems) {
    const listMapped = mapSailingListItem(item, sailing.ship_name, sailing.cruise_line ?? "");
    if (!listMapped) continue;

    if (listMapped.cacheQuote) {
      try {
        await upsertPriceQuote(db, listMapped.cacheQuote);
        result.list_price_cache_written += 1;
      } catch {
        // Price cache failures don't block RAG ingest.
      }
    }

    const outcome = await ingestItineraryToRag(listMapped);
    if (outcome.status === "ingested" || outcome.status === "updated" || outcome.status === "unchanged") {
      result.list_ingested += 1;
    }
  }
}
