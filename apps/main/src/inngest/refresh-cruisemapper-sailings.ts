// #485 follow-up §33.4 — Monthly CruiseMapper sailing refresh.
//
// Cron: 1st of every month at 04:00 UTC. Previously skipped Jan/Apr/Jul/Oct
// because the quarterly static job covered sailing in those months; sailing is
// now decoupled from static and runs every month (#770), so this single cron
// owns sailing refresh year-round.
//
// Kill switch: CRUISEMAPPER_SAILING_INGEST_ENABLED.
//
// Flow:
//   1. Load ship URLs from cruisemapper_url_inventory (kind="ship") — no
//      re-discovery; the quarterly static run keeps the inventory current.
//   2. For each URL: conditional GET via the inventory content_hash → skip
//      unchanged; else parseSailingPage (current itinerary with day_by_day) +
//      parseSailingList (upcoming sailings for price cache) → RAG + pricing
//      cache via processSailingHtml.
//   3. Parse-failure rate > 5% after 20 samples → halt + operator alert.
//
// Durability (#770): ship pages are processed in BATCHES, each batch its own
// Inngest step.run, so no single Vercel invocation accumulates the ~1.7k serial
// sailing POSTs (which exceeds maxDuration) and the step count stays bounded as
// the fleet grows. External fetches are paced by the in-process token bucket
// within each batch invocation, and one platform-admin audit row is written per
// run.
//
// Idempotency: the RAG /api/ingest/itinerary endpoint deduplicates on
// (cruise_line, ship, departure_date, departure_port) + content_hash, and the
// inventory content_hash short-circuits unchanged fetches — so Inngest's
// automatic step retries can't double-write.

import { inngest } from "./client";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";
import { fetchCruiseMapperPage } from "@/lib/external/cruisemapper/diy-fetcher";
import { loadInventoryByKind } from "@/lib/external/cruisemapper/discovery";
import { processSailingHtml, emptySailingResult, mergeSailing, type SailingRunResult } from "@/lib/external/cruisemapper/sailing-ingest";
import { safeAwait } from "@/lib/db/safe-mutation";
import type { SupabaseClient } from "@supabase/supabase-js";

const PARSE_FAILURE_HALT_RATIO = 0.05;
const MIN_SAMPLES_BEFORE_HALT = 20;
// Per-step wall-clock budget (#796/#842). The SAME deadline bounds two loops:
// the inter-ship loop here (stop starting new ships) AND each ship's detail-fetch
// loop in processSailingHtml (stop enriching, defer the rest). Before #842 only
// the inter-ship loop respected it, so a single high-sailing-count ship's 1-req/
// sec detail fetches could run one step past Vercel's 300s maxDuration →
// FUNCTION_INVOCATION_TIMEOUT. Bounding the detail loop too caps the overshoot at
// roughly one in-flight wave (~10-15s), so 240s stays comfortably under 300s.
export const STEP_BUDGET_MS = 240_000;

const AUDIT_META = {
  admin_user_id: "system-cron",
  reason: "external_pricing_refresh",
  operation: "refresh_cruisemapper_sailings",
} as const;

export interface SailingUrlResult {
  sailing: SailingRunResult;
  fetch_unchanged: number; // 0 | 1
  fetch_errors: number; // 0 | 1
  parse_failed: number; // 0 | 1
}

interface SailingWindowResult {
  nextIndex: number;
  attempted: number;
  sailing: SailingRunResult;
  fetch_unchanged: number;
  fetch_errors: number;
  parse_failed: number;
}

// Parse-failure circuit breaker on the running totals across steps. Unchanged
// and fetch-error pages count toward `attempted` but never toward
// `parseFailures`, so a run of mostly-unchanged pages can't trip the halt.
export function sailingHaltReason(attempted: number, parseFailures: number): string | null {
  if (attempted < MIN_SAMPLES_BEFORE_HALT) return null;
  const ratio = parseFailures / attempted;
  if (ratio <= PARSE_FAILURE_HALT_RATIO) return null;
  return `sailing parse_failure_rate ${(ratio * 100).toFixed(1)}% > ${(PARSE_FAILURE_HALT_RATIO * 100).toFixed(0)}% after ${attempted} pages`;
}

// Decide the inventory row update for one ship from its parse + RAG-ingest
// result. content_hash is stamped ONLY when the current itinerary actually
// reached RAG (parsed AND landed) — never on a parse failure or a RAG outage —
// so a failed ingest is retried by the next run's unconditional GET instead of
// being masked as "unchanged". Root cause of the 2026-06-06 gap: the stamp was
// keyed on the local parse alone, so 117 ships whose RAG POST failed during a
// RAG outage were marked "ingested" with a hash and then skipped forever.
export function sailingIngestOutcome(
  parseSucceeded: boolean,
  landedInRag: boolean,
  bodyHash: string,
): { update: Record<string, unknown>; parse_failed: 0 | 1 } {
  const update: Record<string, unknown> = { last_seen_at: new Date().toISOString() };
  if (!parseSucceeded) {
    update.last_ingest_status = "parse_failed";
    update.last_error = "sailing_parser_returned_null";
    return { update, parse_failed: 1 };
  }
  if (!landedInRag) {
    // Parsed fine but the RAG POST didn't land — a transient/outage failure, not
    // a parser problem, so it must NOT count toward the parse-failure halt.
    update.last_ingest_status = "ingest_failed";
    update.last_error = "rag_itinerary_ingest_failed";
    return { update, parse_failed: 0 };
  }
  update.last_ingest_status = "ingested";
  update.last_error = null;
  update.content_hash = bodyHash; // stamped ONLY here — a parse or RAG failure must leave no hash
  return { update, parse_failed: 0 };
}

export interface SailingPageDeltas {
  /** A current sailing parsed this page. */
  hadCurrent: boolean;
  /** No current sailing, but a recognizable ship page (future/river/retired). */
  noCurrentButValidShip: boolean;
  /** The current sailing reached RAG. */
  currentLanded: boolean;
  /** At least one upcoming-list item reached RAG this run. */
  listLanded: boolean;
  /** At least one upcoming-list item was skipped because already-enriched. */
  listSkippedEnriched: boolean;
  /** The page had any upcoming-list items at all. */
  listHadItems: boolean;
}

// Derive the (validShipPage, landedInRag) inputs to sailingIngestOutcome from one
// ship page's counter deltas. Split out so the content_hash-stamping decision —
// the D-171 masking-bug surface — is unit-tested directly (#827 f/u).
//   • validShipPage: a current sailing OR a recognizable no-current ship; only an
//     unrecognizable page is a parse failure that feeds the halt.
//   • landedInRag: with a current sailing, gate on it reaching RAG (preserves the
//     #770 RAG-outage retry). With NO current sailing, the page is fully handled
//     when its list landed, was ALREADY enriched (skipped), or had no items — but
//     NOT when it had items that all failed to land (→ retry, never a false
//     "unchanged" stamp).
export function sailingPageOutcomeInputs(d: SailingPageDeltas): { validShipPage: boolean; landedInRag: boolean } {
  const validShipPage = d.hadCurrent || d.noCurrentButValidShip;
  const landedInRag = d.hadCurrent
    ? d.currentLanded
    : d.listLanded || d.listSkippedEnriched || !d.listHadItems;
  return { validShipPage, landedInRag };
}

// Ferries CruiseMapper lists alongside cruise ships have no ocean-cruise sailing
// to parse, so they always "parse_failed" and inflate the parse-failure halt
// rate without signalling a real parser break (#819). Their URL slug carries a
// hyphen-delimited "-ferry-" token (e.g. .../ships/Stena-Estrid-ferry-2159) — a
// substring like "Ferryland" is NOT matched. Ship intel for them still lands via
// the quarterly static cron; only sailing-itinerary ingest skips them. The run
// summary reports `ferries_skipped` so the filter is auditable in prod.
export function isNonCruiseSailingUrl(url: string): boolean {
  return /-ferry-/i.test(url);
}

// Clear stale parse_failed status on ferry URLs so monitoring shows
// "intentionally skipped" rather than a real parser break (#819).
async function stampFerrySkips(db: SupabaseClient, ferryUrls: string[]): Promise<{ stamped: number }> {
  const { data, error } = await db
    .from("cruisemapper_url_inventory")
    .update({ last_ingest_status: "not_cruise_ship", last_error: null })
    .in("url", ferryUrls)
    .eq("last_ingest_status", "parse_failed")
    .select("url");
  if (error) throw new Error(`stampFerrySkips failed: ${error.message}`);
  return { stamped: (data ?? []).length };
}

export const refreshCruisemapperSailings = inngest.createFunction(
  {
    id: "refresh-cruisemapper-sailings",
    triggers: [{ cron: "0 4 1 * *" }],
  },
  async ({ step }) => {
    if (process.env.STAGING_MODE === "true") return { skipped_for_staging: true };
    if (process.env.CRUISEMAPPER_SAILING_INGEST_ENABLED !== "true") {
      return { skipped: true, reason: "CRUISEMAPPER_SAILING_INGEST_ENABLED=false" };
    }
    if (!process.env.CRUISEMAPPER_DIY_USER_AGENT) {
      return { skipped: true, reason: "CRUISEMAPPER_DIY_USER_AGENT not set" };
    }

    // One platform-admin audit row per run (batch steps use a plain service-role
    // client; wrapping each would emit one audit row per batch).
    await step.run("audit-run", () =>
      withPlatformAdminAudit(AUDIT_META, async (_db, recordQuery) => {
        recordQuery({ op: "select", table: "cruisemapper_url_inventory" });
        return { audited: true };
      }),
    );

    const allShipUrls = await step.run("load-ships", () => loadInventoryByKind(createServiceRoleClient(), "ship"));
    const shipUrls = allShipUrls.filter((u) => !isNonCruiseSailingUrl(u));
    const ferryUrls = allShipUrls.filter((u) => isNonCruiseSailingUrl(u));
    // Stamp any ferry row still showing parse_failed so monitoring reflects
    // "intentionally skipped", not a real parser break (#819).
    if (ferryUrls.length > 0) {
      await step.run("stamp-ferry-skips", () => stampFerrySkips(createServiceRoleClient(), ferryUrls));
    }

    const sailing = emptySailingResult();
    let fetchUnchanged = 0;
    let fetchErrors = 0;
    let attempted = 0;
    let parseFailures = 0;
    let halted = false;
    let haltReasonStr: string | undefined;

    let cursor = 0;
    let stepNum = 0;
    while (cursor < shipUrls.length) {
      const start = cursor;
      const r = await step.run(`sailing-${stepNum}`, () => processSailingWindow(shipUrls, start));
      attempted += r.attempted;
      mergeSailing(sailing, r.sailing);
      fetchUnchanged += r.fetch_unchanged;
      fetchErrors += r.fetch_errors;
      parseFailures += r.parse_failed;
      cursor = r.nextIndex;
      stepNum += 1;

      const reason = sailingHaltReason(attempted, parseFailures);
      if (reason) {
        halted = true;
        haltReasonStr = reason;
        await step.run(`halt-${stepNum - 1}`, () => alertSailingHalt(attempted, parseFailures, reason));
        break;
      }
    }

    return {
      ship_pages_attempted: shipUrls.length,
      ferries_skipped: allShipUrls.length - shipUrls.length,
      ...sailing,
      fetch_unchanged: fetchUnchanged,
      fetch_errors: fetchErrors,
      halted,
      ...(haltReasonStr ? { halt_reason: haltReasonStr } : {}),
    };
  },
);

// Process ship pages starting at `start` in one step, stopping once the wall-
// clock budget is spent so the step can't exceed maxDuration (#796). The
// orchestrator resumes from the returned nextIndex.
async function processSailingWindow(urls: string[], start: number): Promise<SailingWindowResult> {
  const db = createServiceRoleClient();
  return runSailingWindow(urls, start, STEP_BUDGET_MS, (url, deadlineMs) => processOneSailingUrl(db, url, deadlineMs));
}

// Core windowing loop, separated from the service-role wiring so it's unit-
// testable: process `urls` from `start` via `processOne`, stopping once `now()`
// passes the deadline. Always advances at least one ship per call so the run
// makes progress even if a single ship alone exceeds the budget.
export async function runSailingWindow(
  urls: string[],
  start: number,
  budgetMs: number,
  processOne: (url: string, deadlineMs: number) => Promise<SailingUrlResult>,
  now: () => number = Date.now,
): Promise<SailingWindowResult> {
  const sailing = emptySailingResult();
  let fetch_unchanged = 0;
  let fetch_errors = 0;
  let parse_failed = 0;
  let attempted = 0;
  const deadline = now() + budgetMs;
  let i = start;
  while (i < urls.length) {
    let r: SailingUrlResult;
    try {
      r = await processOne(urls[i]!, deadline);
    } catch (err) {
      // #842 — a SINGLE ship's unexpected throw (e.g. a transient Supabase
      // pooler/connection error on its inventory read/write) must NOT fail the
      // whole step + run. Count it as a fetch error and continue; the ship keeps
      // a null content_hash and is retried next run. Without this, Inngest re-runs
      // the step, re-hits the same ship, and eventually marks the run failed
      // ("unknown error from the app"). NOT counted toward the parse-failure halt.
      console.error(`[sailing-cron] ship processing threw — counting as fetch_error + continuing: ${urls[i]}`, err);
      r = { sailing: emptySailingResult(), fetch_unchanged: 0, fetch_errors: 1, parse_failed: 0 };
    }
    mergeSailing(sailing, r.sailing);
    fetch_unchanged += r.fetch_unchanged;
    fetch_errors += r.fetch_errors;
    parse_failed += r.parse_failed;
    attempted += 1;
    i += 1;
    if (now() >= deadline) break;
  }
  return { nextIndex: i, attempted, sailing, fetch_unchanged, fetch_errors, parse_failed };
}

export async function alertSailingHalt(attempted: number, parseFailures: number, reason: string): Promise<{ alerted: true }> {
  await sendOperatorAlert({
    severity: "high",
    signal: "cruisemapper_sailing_parser_failure_rate",
    detail: reason,
    payload: { attempted, failures: parseFailures },
  });
  return { alerted: true };
}

async function priorShipHash(db: SupabaseClient, url: string): Promise<string | undefined> {
  const { data, error } = await db
    .from("cruisemapper_url_inventory")
    .select("content_hash")
    .eq("url", url)
    .eq("kind", "ship")
    .maybeSingle();
  if (error) throw new Error(`cruisemapper_url_inventory.select failed: ${error.message}`);
  return (data as { content_hash: string | null } | null)?.content_hash ?? undefined;
}

// Process ONE ship page's sailing data: conditional GET → parse current sailing
// + upcoming list → RAG + pricing cache via processSailingHtml. Returns the
// single-URL counters the batch aggregates.
// skipHashCheck=true forces a full page fetch regardless of content_hash — used by
// the port backfill trigger (#831) to enrich already-scheduled sailings without a
// manual SQL hash-clear. The existing sailingDetailEnriched gate still skips sailings
// whose ports are already recorded.
export async function processOneSailingUrl(db: SupabaseClient, url: string, deadlineMs: number = Number.POSITIVE_INFINITY, skipHashCheck = false): Promise<SailingUrlResult> {
  const sailing = emptySailingResult();

  const previousBodyHash = skipHashCheck ? undefined : await priorShipHash(db, url);
  const fetched = await fetchCruiseMapperPage(url, previousBodyHash ? { previousBodyHash } : {});

  if (fetched.status === "unchanged") {
    // Touch last_seen_at so inventory doesn't look stale.
    await safeAwait(
      db.from("cruisemapper_url_inventory")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("url", url)
        .eq("kind", "ship"),
      "cruisemapper_url_inventory.update",
    );
    return { sailing, fetch_unchanged: 1, fetch_errors: 0, parse_failed: 0 };
  }

  if (fetched.status !== "ok") {
    await safeAwait(
      db.from("cruisemapper_url_inventory")
        .update({ last_seen_at: new Date().toISOString(), last_ingest_status: fetched.status, last_error: fetched.status })
        .eq("url", url)
        .eq("kind", "ship"),
      "cruisemapper_url_inventory.update.sailing_error",
    );
    return { sailing, fetch_unchanged: 0, fetch_errors: 1, parse_failed: 0 };
  }

  const before = {
    current_parsed: sailing.current_parsed,
    no_current_sailing: sailing.no_current_sailing,
    current_ingested: sailing.current_ingested,
    list_ingested: sailing.list_ingested,
    list_details_skipped_enriched: sailing.list_details_skipped_enriched,
    list_items: sailing.list_items,
    list_details_deferred: sailing.list_details_deferred,
  };
  await processSailingHtml(db, fetched.body, url, sailing, deadlineMs);
  // Compute the outcome from this page's counter deltas (see sailingPageOutcomeInputs:
  // valid-ship + landed-in-RAG, the content_hash-stamping / parse-failure-halt surface).
  const { validShipPage, landedInRag } = sailingPageOutcomeInputs({
    hadCurrent: sailing.current_parsed > before.current_parsed,
    noCurrentButValidShip: sailing.no_current_sailing > before.no_current_sailing,
    currentLanded: sailing.current_ingested > before.current_ingested,
    listLanded: sailing.list_ingested > before.list_ingested,
    listSkippedEnriched: sailing.list_details_skipped_enriched > before.list_details_skipped_enriched,
    listHadItems: sailing.list_items > before.list_items,
  });

  // #842 — if the detail-fetch deadline left sailings un-enriched, the page did
  // NOT fully land: withhold the content_hash so the next run resumes the ship
  // (already-enriched sailings skip via the gate). Still a valid ship and not a
  // parse failure — only the "fully landed" signal is suppressed.
  const deferred = sailing.list_details_deferred > before.list_details_deferred;
  const { update, parse_failed } = sailingIngestOutcome(validShipPage, landedInRag && !deferred, fetched.bodyHash);
  await safeAwait(
    db.from("cruisemapper_url_inventory").update(update).eq("url", url).eq("kind", "ship"),
    "cruisemapper_url_inventory.update.sailing",
  );

  return { sailing, fetch_unchanged: 0, fetch_errors: 0, parse_failed };
}
