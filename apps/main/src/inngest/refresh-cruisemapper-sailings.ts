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
// Per-step wall-clock budget (#796). A step processes ships until this is spent
// (always finishing the current ship + at least one), then the orchestrator
// resumes from the returned cursor — so no single Inngest step exceeds
// maxDuration regardless of any ship's sailing count. Kept well under the 300s
// function limit to leave headroom for the in-progress ship to finish.
const STEP_BUDGET_MS = 180_000;

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

    const shipUrls = await step.run("load-ships", () => loadInventoryByKind(createServiceRoleClient(), "ship"));

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
        await step.run(`halt-${stepNum}`, () => alertSailingHalt(attempted, parseFailures, reason));
        break;
      }
    }

    return {
      ship_pages_attempted: shipUrls.length,
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
  return runSailingWindow(urls, start, STEP_BUDGET_MS, (url) => processOneSailingUrl(db, url));
}

// Core windowing loop, separated from the service-role wiring so it's unit-
// testable: process `urls` from `start` via `processOne`, stopping once `now()`
// passes the deadline. Always advances at least one ship per call so the run
// makes progress even if a single ship alone exceeds the budget.
export async function runSailingWindow(
  urls: string[],
  start: number,
  budgetMs: number,
  processOne: (url: string) => Promise<SailingUrlResult>,
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
    const r = await processOne(urls[i]!);
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

async function alertSailingHalt(attempted: number, parseFailures: number, reason: string): Promise<{ alerted: true }> {
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
async function processOneSailingUrl(db: SupabaseClient, url: string): Promise<SailingUrlResult> {
  const sailing = emptySailingResult();

  const previousBodyHash = await priorShipHash(db, url);
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

  const beforeParsed = sailing.current_parsed;
  await processSailingHtml(db, fetched.body, url, sailing);
  const parseSucceeded = sailing.current_parsed > beforeParsed;

  // Stamp the body hash so next month's conditional GET skips unchanged pages.
  await safeAwait(
    db.from("cruisemapper_url_inventory")
      .update({
        last_seen_at: new Date().toISOString(),
        content_hash: fetched.bodyHash,
        last_ingest_status: parseSucceeded ? "ingested" : "parse_failed",
        last_error: parseSucceeded ? null : "sailing_parser_returned_null",
      })
      .eq("url", url)
      .eq("kind", "ship"),
    "cruisemapper_url_inventory.update.sailing",
  );

  return { sailing, fetch_unchanged: 0, fetch_errors: 0, parse_failed: parseSucceeded ? 0 : 1 };
}
