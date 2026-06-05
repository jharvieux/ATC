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
  list_price_cache_errors: number;
  list_ingested: number;
  list_errors: number;
}

export function emptySailingResult(): SailingRunResult {
  return {
    current_parsed: 0,
    current_ingested: 0,
    current_errors: 0,
    list_items: 0,
    list_price_cache_written: 0,
    list_price_cache_errors: 0,
    list_ingested: 0,
    list_errors: 0,
  };
}

// Sum a per-URL sailing result into a running total. Used when each ship page
// is processed in its own Inngest step (#770) and the per-step results are
// aggregated by the orchestrator.
export function mergeSailing(into: SailingRunResult, one: SailingRunResult): void {
  into.current_parsed += one.current_parsed;
  into.current_ingested += one.current_ingested;
  into.current_errors += one.current_errors;
  into.list_items += one.list_items;
  into.list_price_cache_written += one.list_price_cache_written;
  into.list_price_cache_errors += one.list_price_cache_errors;
  into.list_ingested += one.list_ingested;
  into.list_errors += one.list_errors;
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
      } catch (err) {
        // Best-effort — price cache is a convenience mirror; RAG ingest proceeds.
        console.warn("[sailing-ingest] price-cache upsert failed (non-fatal)",
          { shipUrl, data_row_id: item.data_row_id, err });
        result.list_price_cache_errors += 1;
      }
    }

    const outcome = await ingestItineraryToRag(listMapped);
    if (outcome.status === "ingested" || outcome.status === "updated" || outcome.status === "unchanged") {
      result.list_ingested += 1;
    } else {
      result.list_errors += 1;
    }
  }
}
