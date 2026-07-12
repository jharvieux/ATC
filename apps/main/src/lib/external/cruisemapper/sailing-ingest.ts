// #485 follow-up §33.4 — shared sailing ingest helper.
//
// Called from both refresh-cruisemapper-static (quarterly, reuses the ship-page
// fetch) and refresh-cruisemapper-sailings (monthly, fetches ship pages anew).
// Parses current sailing + upcoming list from already-fetched HTML, maps both
// to MappedItinerary, and ingests to RAG + pricing cache.

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseSailingPage, parseShipIdentity, type ParsedSailingDay } from "./parsers/sailing-parser";
import { parseSailingList, type SailingListItem } from "./parsers/sailing-list-parser";
import { parseCruiseExpand } from "./parsers/cruise-expand-parser";
import { mapSailing, mapSailingListItem, type MappedItinerary } from "./itinerary-mapper";
import { ingestItineraryToRag } from "./rag-itinerary-ingest";
import { fetchCruiseMapperPage } from "./diy-fetcher";
import { upsertPriceQuote } from "@/lib/pricing/pricing-cache";
import { safeAwait } from "@/lib/db/safe-mutation";

// Per-ship upcoming-sailing ingests run in bounded-concurrency waves (#796) so a
// high-sailing-count ship doesn't serialize hundreds of RAG POSTs into the cron
// step's wall-time. The ingests are independent + idempotent (content_hash).
const SAILING_POST_CONCURRENCY = 8;

export interface SailingRunResult {
  current_parsed: number;
  current_ingested: number;
  current_errors: number;
  // Valid ship page that has NO current sailing yet (future/unlaunched, river,
  // retired). NOT a parse failure — the upcoming-sailings list is still ingested.
  no_current_sailing: number;
  list_items: number;
  list_price_cache_written: number;
  list_price_cache_errors: number;
  list_ingested: number;
  list_errors: number;
  // #827 per-sailing detail (cruise.json) enrichment counters.
  list_details_fetched: number;          // detail fetched + parsed this run
  list_details_skipped_enriched: number; // already had ports — no fetch
  list_details_errors: number;           // detail fetch/parse failed
  // #842 — sailings left un-enriched because the step's detail-fetch deadline was
  // reached (1 req/sec would push the Vercel function past maxDuration). The ship
  // is NOT stamped complete; the next run resumes it (already-enriched ones skip).
  list_details_deferred: number;
  // #783 — structured catalog (cruise_sailings + sailing_port_calls) persistence.
  catalog_upserted: number;   // sailing row written/updated this run
  catalog_errors: number;     // upsert failed (ship found in catalog but DB write failed)
}

export function emptySailingResult(): SailingRunResult {
  return {
    current_parsed: 0,
    current_ingested: 0,
    current_errors: 0,
    no_current_sailing: 0,
    list_items: 0,
    list_price_cache_written: 0,
    list_price_cache_errors: 0,
    list_ingested: 0,
    list_errors: 0,
    list_details_fetched: 0,
    list_details_skipped_enriched: 0,
    list_details_errors: 0,
    list_details_deferred: 0,
    catalog_upserted: 0,
    catalog_errors: 0,
  };
}

// Sum a per-URL sailing result into a running total. Used when each ship page
// is processed in its own Inngest step (#770) and the per-step results are
// aggregated by the orchestrator.
export function mergeSailing(into: SailingRunResult, one: SailingRunResult): void {
  into.current_parsed += one.current_parsed;
  into.current_ingested += one.current_ingested;
  into.current_errors += one.current_errors;
  into.no_current_sailing += one.no_current_sailing;
  into.list_items += one.list_items;
  into.list_price_cache_written += one.list_price_cache_written;
  into.list_price_cache_errors += one.list_price_cache_errors;
  into.list_ingested += one.list_ingested;
  into.list_errors += one.list_errors;
  into.list_details_fetched += one.list_details_fetched;
  into.list_details_skipped_enriched += one.list_details_skipped_enriched;
  into.list_details_errors += one.list_details_errors;
  into.list_details_deferred += one.list_details_deferred;
  into.catalog_upserted += one.catalog_upserted;
  into.catalog_errors += one.catalog_errors;
}

// #827 — per-sailing detail (cruise.json) enrichment.
//
// Each upcoming sailing's ports live behind /ships/cruise.json?id=<row>, loaded
// lazily by the page JS. We fetch + parse it ONCE per sailing, then record it in
// cruisemapper_url_inventory (kind="sailing_detail") so later runs skip the
// fetch — ports are immutable once a sailing is scheduled. Gated by
// CRUISEMAPPER_DETAIL_FETCH_ENABLED; when off, list items map with no ports
// exactly as before (the gate defaults closed — this is a scraping-volume op).

function sailingDetailUrl(dataRowId: string): string {
  const base = (process.env.CRUISEMAPPER_DIY_BASE_URL ?? "https://www.cruisemapper.com").replace(/\/$/, "");
  return `${base}/ships/cruise.json?id=${encodeURIComponent(dataRowId)}`;
}

// True when this sailing's ports were already fetched + ingested — skip re-fetch.
async function sailingDetailEnriched(db: SupabaseClient, detailUrl: string): Promise<boolean> {
  const { data, error } = await db
    .from("cruisemapper_url_inventory")
    .select("last_ingest_status")
    .eq("url", detailUrl)
    .eq("kind", "sailing_detail")
    .maybeSingle();
  if (error) throw new Error(`cruisemapper_url_inventory.select(sailing_detail) failed: ${error.message}`);
  return (data as { last_ingest_status: string | null } | null)?.last_ingest_status === "ingested";
}

// Fetch + parse one sailing's day-by-day. Returns null on any fetch/parse miss,
// so the caller proceeds without ports and retries next run (never marks it
// enriched). The XHR header is REQUIRED — without it cruise.json 200s with an
// empty body.
async function fetchSailingDetail(
  item: SailingListItem,
): Promise<{ portsOfCall: string[]; dayByDay: ParsedSailingDay[] } | null> {
  const fetched = await fetchCruiseMapperPage(sailingDetailUrl(item.data_row_id), {
    headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" },
  });
  if (fetched.status !== "ok") return null;
  let fragment: unknown;
  try {
    fragment = (JSON.parse(fetched.body) as { result?: unknown }).result;
  } catch {
    return null;
  }
  if (typeof fragment !== "string" || fragment.length === 0) return null;
  const parsed = parseCruiseExpand(fragment, {
    departureDate: item.departure_date,
    durationNights: item.duration_nights,
  });
  if (!parsed) return null;
  return { portsOfCall: parsed.ports_of_call, dayByDay: parsed.itinerary };
}

// Record a sailing's detail as enriched so later runs skip the fetch.
async function markSailingDetailEnriched(db: SupabaseClient, detailUrl: string): Promise<void> {
  await safeAwait(
    db.from("cruisemapper_url_inventory").upsert(
      {
        url: detailUrl,
        kind: "sailing_detail",
        last_seen_at: new Date().toISOString(),
        last_ingest_status: "ingested",
        last_error: null,
      },
      { onConflict: "url" },
    ),
    "cruisemapper_url_inventory.upsert.sailing_detail",
  );
}

// #783 — Structured sailing catalog persistence (cruise_sailings + sailing_port_calls).
//
// These three helpers run best-effort alongside RAG ingest: failures are logged
// but never abort the ingest. The catalog is populated from already-computed
// MappedItinerary fields, so no extra parsing is needed.

// Last path segment of a /ships/<slug> URL.
function extractCruisemapperSlug(shipUrl: string): string | null {
  try {
    const segments = new URL(shipUrl).pathname.split("/").filter(Boolean);
    if (segments.length >= 2 && segments[0] === "ships") return segments[1] ?? null;
    return null;
  } catch {
    return null;
  }
}

// Resolve the cruise_ships.id for a ship page URL. Returns null when the ship
// is not yet in the catalog (newly-discovered ships are inserted by the static
// refresh step; the sailing ingest runs after it, so a miss is rare).
async function lookupCruiseShipId(db: SupabaseClient, shipUrl: string): Promise<string | null> {
  const slug = extractCruisemapperSlug(shipUrl);
  if (!slug) return null;
  const { data, error } = await db
    .from("cruise_ships")
    .select("id")
    .eq("cruisemapper_slug", slug)
    .maybeSingle();
  if (error) {
    console.error("[sailing-ingest] cruise_ships lookup failed", { shipUrl, slug, error: error.message });
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}

// Upsert one sailing row. Conflict target: UNIQUE(cruise_ship_id, departure_date).
// Returns the row ID so port calls can reference it, or null on failure.
async function persistSailing(
  db: SupabaseClient,
  cruiseShipId: string,
  mapped: MappedItinerary,
): Promise<string | null> {
  const { data, error } = await db
    .from("cruise_sailings")
    .upsert(
      {
        cruise_ship_id: cruiseShipId,
        departure_date: mapped.key.sailDate,
        departure_port: mapped.key.departurePort,
        duration_nights: mapped.key.durationNights,
        region: mapped.region,
        starting_price: mapped.startingPriceUsd,
        source_url: mapped.sourceUrl,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "cruise_ship_id,departure_date" },
    )
    .select("id")
    .single();
  if (error) {
    console.error("[sailing-ingest] cruise_sailings upsert failed",
      { cruiseShipId, sailDate: mapped.key.sailDate, error: error.message });
    return null;
  }
  return (data as { id: string }).id;
}

// Bulk-upsert port calls for a sailing. Conflict: UNIQUE(sailing_id, day_index).
async function persistPortCalls(
  db: SupabaseClient,
  sailingId: string,
  portsOfCall: string[],
): Promise<boolean> {
  if (portsOfCall.length === 0) return true;
  const rows = portsOfCall.map((port_name, day_index) => ({ sailing_id: sailingId, port_name, day_index }));
  const { error } = await db
    .from("sailing_port_calls")
    .upsert(rows, { onConflict: "sailing_id,day_index" });
  if (error) {
    console.error("[sailing-ingest] sailing_port_calls upsert failed", { sailingId, error: error.message });
    return false;
  }
  return true;
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
  // #842 — absolute wall-clock deadline (ms) for this ship's detail-fetch work.
  // The detail loop runs at ~1 req/sec, so a high-sailing-count ship can push a
  // single Inngest step past Vercel's 300s maxDuration (→ FUNCTION_INVOCATION_TIMEOUT).
  // Once reached, remaining sailings are deferred to the next run. Defaults to no
  // deadline (the static-page path / tests don't fetch details under time pressure).
  deadlineMs: number = Number.POSITIVE_INFINITY,
): Promise<void> {
  const cruiseShipId = await lookupCruiseShipId(db, shipUrl);

  // Current sailing (with full day_by_day) — may be ABSENT for a future/
  // unlaunched, river, or retired ship. That is NOT a parse failure as long as
  // the page is a recognizable ship page (has an <h1>): we still ingest its
  // upcoming-sailings list (which carries the future itineraries + ports). Only a
  // page with no identity is a genuine break that should feed the parse-failure
  // halt (#827 follow-up — these no-current ships were tripping the 5% halt).
  const sailing = parseSailingPage(html, shipUrl);
  let shipName: string;
  let cruiseLine: string;
  if (sailing) {
    result.current_parsed += 1;
    const mapped = mapSailing(sailing);
    if (mapped) {
      const outcome = await ingestItineraryToRag(mapped);
      if (outcome.status === "ingested" || outcome.status === "updated" || outcome.status === "unchanged") {
        result.current_ingested += 1;
      } else {
        result.current_errors += 1;
      }
      if (cruiseShipId) {
        const sailingId = await persistSailing(db, cruiseShipId, mapped);
        if (sailingId) {
          result.catalog_upserted += 1;
          if (mapped.portsOfCall.length > 0) {
            const ok = await persistPortCalls(db, sailingId, mapped.portsOfCall);
            if (!ok) result.catalog_errors += 1;
          }
        } else {
          result.catalog_errors += 1;
        }
      }
    } else {
      result.current_errors += 1;
    }
    shipName = sailing.ship_name;
    cruiseLine = sailing.cruise_line ?? "";
  } else {
    const identity = parseShipIdentity(html);
    if (!identity) {
      result.current_errors += 1;
      return;
    }
    result.no_current_sailing += 1;
    shipName = identity.ship_name;
    cruiseLine = identity.cruise_line ?? "";
  }

  // Upcoming sailings list — prices + RAG text, no day_by_day. Independent +
  // idempotent per item, so process them in bounded-concurrency waves (#796)
  // instead of one serial await per sailing.
  const listItems = parseSailingList(html);
  result.list_items += listItems.length;
  const detailEnabled = process.env.CRUISEMAPPER_DETAIL_FETCH_ENABLED === "true";

  for (let i = 0; i < listItems.length; i += SAILING_POST_CONCURRENCY) {
    // #842 — stop enriching once the step deadline is reached so a single ship's
    // 1-req/sec detail fetches can't run the Vercel function past maxDuration.
    // The remaining sailings are deferred (ship not stamped complete → resumed
    // next run, where already-enriched ones skip via the sailing_detail gate).
    // Only detail-fetching is time-bounded; without it the loop is cheap.
    if (detailEnabled && Date.now() >= deadlineMs) {
      result.list_details_deferred += listItems.length - i;
      break;
    }
    await Promise.all(
      listItems.slice(i, i + SAILING_POST_CONCURRENCY).map(async (item) => {
        // Price cache refreshes EVERY run, independent of port enrichment — it's
        // the lead-in source the pricing anchors (#828) read, and the price
        // drifts as a sailing fills. Build the base (no-ports) mapping for it.
        const baseMapped = mapSailingListItem(item, shipName, cruiseLine);
        if (baseMapped?.cacheQuote) {
          try {
            await upsertPriceQuote(db, baseMapped.cacheQuote);
            result.list_price_cache_written += 1;
          } catch (err) {
            // Best-effort — price cache is a convenience mirror; RAG ingest proceeds.
            console.warn("[sailing-ingest] price-cache upsert failed (non-fatal)",
              { shipUrl, data_row_id: item.data_row_id, err });
            result.list_price_cache_errors += 1;
          }
        }

        // #827 — port enrichment (gated). An already-enriched sailing keeps its
        // RAG ports as-is: skip BOTH the detail re-fetch AND the RAG re-ingest,
        // since re-ingesting without the ports (which we don't hold locally)
        // would clobber them. Its price was already refreshed above.
        let detail: { portsOfCall: string[]; dayByDay: ParsedSailingDay[] } | undefined;
        let detailUrl: string | undefined;
        if (detailEnabled) {
          detailUrl = sailingDetailUrl(item.data_row_id);
          let alreadyEnriched = false;
          try {
            alreadyEnriched = await sailingDetailEnriched(db, detailUrl);
          } catch (err) {
            console.warn("[sailing-ingest] detail enriched-check failed (treating as not enriched)",
              { shipUrl, data_row_id: item.data_row_id, err });
          }
          if (alreadyEnriched) {
            result.list_details_skipped_enriched += 1;
            return;
          }
          const parsed = await fetchSailingDetail(item);
          if (parsed) {
            detail = parsed;
            result.list_details_fetched += 1;
          } else {
            result.list_details_errors += 1;
          }
        }

        // Re-map WITH ports when we fetched detail this run; otherwise the base
        // (no-ports) mapping is what lands.
        const listMapped = detail
          ? mapSailingListItem(item, shipName, cruiseLine, detail)
          : baseMapped;
        if (!listMapped) return;

        const outcome = await ingestItineraryToRag(listMapped);
        if (outcome.status === "ingested" || outcome.status === "updated" || outcome.status === "unchanged") {
          result.list_ingested += 1;
          // Mark enriched ONLY after the ports actually landed in RAG, so a
          // failed ingest is re-fetched next run instead of permanently skipped.
          if (detail && detailUrl) {
            try {
              await markSailingDetailEnriched(db, detailUrl);
            } catch (err) {
              console.warn("[sailing-ingest] mark-enriched failed (will re-fetch next run)",
                { shipUrl, data_row_id: item.data_row_id, err });
            }
          }
        } else {
          result.list_errors += 1;
        }
        if (cruiseShipId) {
          const sailingId = await persistSailing(db, cruiseShipId, listMapped);
          if (sailingId) {
            result.catalog_upserted += 1;
            if (detail && detail.portsOfCall.length > 0) {
              const ok = await persistPortCalls(db, sailingId, detail.portsOfCall);
              if (!ok) result.catalog_errors += 1;
            }
          } else {
            result.catalog_errors += 1;
          }
        }
      }),
    );
  }
}
