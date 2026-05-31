// #485 follow-up §33.4 — Monthly CruiseMapper sailing refresh (non-quarterly months).
//
// Cron: 1st of Feb, Mar, May, Jun, Aug, Sep, Nov, Dec at 04:00 UTC.
// Jan, Apr, Jul, Oct are covered by refresh-cruisemapper-static (quarterly),
// which already runs both ship + sailing parsers on the same fetch.
//
// Kill switch: CRUISEMAPPER_SAILING_INGEST_ENABLED.
//
// Flow:
//   1. Load ship URLs from cruisemapper_url_inventory (kind="ship") — no
//      re-discovery; the quarterly run keeps the inventory current.
//   2. For each URL: fetch with body-hash conditional GET (previousBodyHash from
//      inventory) → skip unchanged pages entirely.
//   3. Run parseSailingPage (current itinerary with day_by_day) + parseSailingList
//      (upcoming sailings for price cache updates) on the fetched HTML.
//   4. Ingest to RAG + pricing cache via processSailingHtml.
//   5. Parse-failure rate > 5% after 20 samples → halt + operator alert.
//
// Idempotency: the RAG /api/ingest/itinerary endpoint deduplicates on
// (cruise_line, ship, departure_date, departure_port) + content_hash. Unchanged
// sailings are no-ops at the RAG layer even if the page body changed.

import { inngest } from "./client";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";
import { fetchCruiseMapperPage } from "@/lib/external/cruisemapper/diy-fetcher";
import { processSailingHtml, emptySailingResult, type SailingRunResult } from "@/lib/external/cruisemapper/sailing-ingest";
import { safeAwait } from "@/lib/db/safe-mutation";
import type { SupabaseClient } from "@supabase/supabase-js";

const PARSE_FAILURE_HALT_RATIO = 0.05;
const MIN_SAMPLES_BEFORE_HALT = 20;

export const refreshCruisemapperSailings = inngest.createFunction(
  {
    id: "refresh-cruisemapper-sailings",
    // Months 2,3,5,6,8,9,11,12 — skip Jan/Apr/Jul/Oct (quarterly handles those).
    triggers: [{ cron: "0 4 1 2,3,5,6,8,9,11,12 *" }],
  },
  async () => {
    if (process.env.STAGING_MODE === "true") return { skipped_for_staging: true };
    if (process.env.CRUISEMAPPER_SAILING_INGEST_ENABLED !== "true") {
      return { skipped: true, reason: "CRUISEMAPPER_SAILING_INGEST_ENABLED=false" };
    }
    if (!process.env.CRUISEMAPPER_DIY_USER_AGENT) {
      return { skipped: true, reason: "CRUISEMAPPER_DIY_USER_AGENT not set" };
    }

    return withPlatformAdminAudit(
      {
        admin_user_id: "system-cron",
        reason: "external_pricing_refresh",
        operation: "refresh_cruisemapper_sailings",
      },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "cruisemapper_url_inventory" });
        const shipUrls = await loadShipUrls(db);
        const result = await processSailingUrls(db, shipUrls);
        return { ship_pages_attempted: shipUrls.length, ...result };
      },
    );
  },
);

async function loadShipUrls(db: SupabaseClient): Promise<string[]> {
  const { data } = await db
    .from("cruisemapper_url_inventory")
    .select("url")
    .eq("kind", "ship");
  return ((data ?? []) as Array<{ url: string }>).map((r) => r.url);
}

async function processSailingUrls(
  db: SupabaseClient,
  urls: string[],
): Promise<SailingRunResult & { fetch_unchanged: number; fetch_errors: number; halted: boolean; halt_reason?: string }> {
  const sailing = emptySailingResult();
  let fetchUnchanged = 0;
  let fetchErrors = 0;
  let halted = false;
  let haltReason: string | undefined;

  // Load content hashes from the inventory for conditional GETs.
  const { data: prior } = await db
    .from("cruisemapper_url_inventory")
    .select("url, content_hash")
    .eq("kind", "ship")
    .in("url", urls.slice(0, 5000));
  const priorHashByUrl = new Map<string, string>();
  for (const row of (prior ?? []) as Array<{ url: string; content_hash: string | null }>) {
    if (row.content_hash) priorHashByUrl.set(row.url, row.content_hash);
  }

  let attempted = 0;
  let parseFailures = 0;

  for (const url of urls) {
    attempted += 1;

    if (attempted >= MIN_SAMPLES_BEFORE_HALT) {
      const ratio = parseFailures / attempted;
      if (ratio > PARSE_FAILURE_HALT_RATIO) {
        halted = true;
        haltReason = `sailing parse_failure_rate ${(ratio * 100).toFixed(1)}% > ${(PARSE_FAILURE_HALT_RATIO * 100).toFixed(0)}% after ${attempted} pages`;
        await sendOperatorAlert({
          severity: "high",
          signal: "cruisemapper_sailing_parser_failure_rate",
          detail: haltReason,
          payload: { attempted, failures: parseFailures },
        });
        break;
      }
    }

    const previousBodyHash = priorHashByUrl.get(url);
    const fetched = await fetchCruiseMapperPage(
      url,
      previousBodyHash ? { previousBodyHash } : {},
    );

    if (fetched.status === "unchanged") {
      fetchUnchanged += 1;
      // Touch last_seen_at so inventory doesn't look stale.
      await safeAwait(
        db.from("cruisemapper_url_inventory")
          .update({ last_seen_at: new Date().toISOString() })
          .eq("url", url)
          .eq("kind", "ship"),
        "cruisemapper_url_inventory.update",
      );
      continue;
    }

    if (fetched.status !== "ok") {
      fetchErrors += 1;
      continue;
    }

    const beforeParsed = sailing.current_parsed;
    await processSailingHtml(db, fetched.body, url, sailing);
    if (sailing.current_parsed === beforeParsed) {
      parseFailures += 1;
    }
  }

  return {
    ...sailing,
    fetch_unchanged: fetchUnchanged,
    fetch_errors: fetchErrors,
    halted,
    ...(haltReason ? { halt_reason: haltReason } : {}),
  };
}
