// BP35 §33.4 — CruiseMapper itinerary actor wrapper.
//
// ── DEPRECATED 2026-05-26 (D-088) ───────────────────────────────────────
// This actor is no longer called by any scheduled cron. The Apify
// monthly itinerary refresh path was removed per D-088: general-pricing
// context for the AI now comes from the DIY CruiseMapper scraper
// (apps/main/src/lib/external/cruisemapper/diy-fetcher.ts) which is free.
// Apify is reserved EXCLUSIVELY for daily price-watch refresh on
// sailings that have an active price_watches row.
//
// File kept (not deleted) so the test suite + history can reference
// it; CRUISEMAPPER_ITINERARY_INGEST_ENABLED remains as a kill switch
// in case manual ad-hoc runs are needed before the DIY replacement
// fully covers itinerary data.
// ────────────────────────────────────────────────────────────────────────
//
// Original docstring (pre-D-088):
//   Dispatches the `crawlerbros/cruisemapper-cruises-scraper` actor with
//   the broadest viable input — all destinations, next 24 months. Honours
//   the same guard fence as the per-line scrapers (token, kill switch,
//   monthly cap).

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";
import { checkMonthlyBudget } from "@/lib/pricing/budget-priority";

const APIFY_RUN_TIMEOUT_MS = 5 * 60 * 1000;

export interface ActorRunResult {
  status: "succeeded" | "skipped" | "failed";
  items: unknown[];
  actor_run_id: string | null;
  spend_usd: number;
  reason?: string;
}

export interface RunOptions {
  /** Months forward to fetch (default 24 per spec). */
  monthsForward?: number;
  /** Optional regions filter passed to the actor. */
  regions?: string[];
}

export async function runCruiseMapperItineraryActor(
  db: SupabaseClient,
  opts: RunOptions = {},
): Promise<ActorRunResult> {
  if (process.env.CRUISEMAPPER_ITINERARY_INGEST_ENABLED !== "true") {
    return skip("ingest_disabled", "CRUISEMAPPER_ITINERARY_INGEST_ENABLED=false");
  }
  if (process.env.APIFY_ADAPTER_ENABLED !== "true") {
    return skip("adapter_disabled", "APIFY_ADAPTER_ENABLED=false");
  }
  const token = process.env.APIFY_API_TOKEN;
  if (!token) return skip("no_api_token", "APIFY_API_TOKEN not set");

  // D-088: this surface is deprecated. If the operator manually flips
  // CRUISEMAPPER_ITINERARY_INGEST_ENABLED=true for an ad-hoc run, the
  // same monthly cap that protects tracked-sailings still applies.
  const monthly = await monthlySpendUsd(db);
  const gate = checkMonthlyBudget(monthly);
  if (gate.paused) {
    await sendOperatorAlert({
      severity: "high",
      signal: "apify_monthly_budget_exhausted",
      detail: `Apify monthly cap of $${gate.cap_usd.toFixed(2)} reached ($${monthly.toFixed(2)}). CruiseMapper itinerary actor (deprecated, ad-hoc only) refused.`,
      payload: { monthly_spend_usd: monthly, surface: "cruisemapper_itinerary_deprecated" },
    });
    return skip("monthly_budget_exhausted", `monthly cap $${gate.cap_usd.toFixed(2)} reached`);
  }

  const actorId = process.env.CRUISEMAPPER_ITINERARY_ACTOR_ID ?? "crawlerbros/cruisemapper-cruises-scraper";

  const now = new Date();
  const monthsForward = opts.monthsForward ?? 24;
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsForward, 0));
  const actorInput: Record<string, unknown> = {
    dateRange: {
      from: now.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
    },
    ...(opts.regions ? { regions: opts.regions } : {}),
  };

  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APIFY_RUN_TIMEOUT_MS);
  let items: unknown[] = [];
  let actorRunId: string | null = null;
  let spend = 0;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(actorInput),
      signal: controller.signal,
    });
    if (!res.ok) {
      const reason = `actor ${actorId} returned ${res.status}`;
      await writeLedger(db, actorId, null, 0, "failed", { error: reason });
      return { status: "failed", items: [], actor_run_id: null, spend_usd: 0, reason };
    }
    items = (await res.json()) as unknown[];
    actorRunId = res.headers.get("x-apify-actor-run-id");
    // CruiseMapper actor is a known higher-volume run; estimate $0.10/result.
    spend = items.length * 0.1;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await writeLedger(db, actorId, null, 0, "failed", { error: reason });
    return { status: "failed", items: [], actor_run_id: null, spend_usd: 0, reason };
  } finally {
    clearTimeout(timer);
  }

  await writeLedger(db, actorId, actorRunId, spend, "succeeded", { results_count: items.length, surface: "cruisemapper_itinerary" });
  return { status: "succeeded", items, actor_run_id: actorRunId, spend_usd: spend };
}

async function monthlySpendUsd(db: SupabaseClient): Promise<number> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const { data } = await db
    .from("apify_spend_ledger")
    .select("spend_usd")
    .gte("invoked_at", monthStart.toISOString());
  const rows = (data ?? []) as Array<{ spend_usd: number }>;
  return rows.reduce((s, r) => s + Number(r.spend_usd), 0);
}

async function writeLedger(
  db: SupabaseClient,
  actorId: string,
  runId: string | null,
  spend: number,
  status: "succeeded" | "failed",
  context: Record<string, unknown>,
): Promise<void> {
  await db.from("apify_spend_ledger").insert({
    actor_id: actorId,
    actor_run_id: runId,
    spend_usd: spend,
    status,
    context,
  });
}

function skip(reason: string, detail: string): ActorRunResult {
  return { status: "skipped", items: [], actor_run_id: null, spend_usd: 0, reason: `${reason}: ${detail}` };
}
