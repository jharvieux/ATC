// BP35 §33.4 — CruiseMapper itinerary actor wrapper.
//
// Dispatches the `crawlerbros/cruisemapper-cruises-scraper` actor (actor id
// configurable via CRUISEMAPPER_ITINERARY_ACTOR_ID) with the broadest
// viable input — all destinations, the next 24 months of departures.
//
// Honours the same BP34 guard fence as the per-line scrapers:
//   - APIFY_ADAPTER_ENABLED=true required
//   - APIFY_API_TOKEN set required
//   - CRUISEMAPPER_ITINERARY_INGEST_ENABLED=true required (this surface)
//   - APIFY_MONTHLY_BUDGET_USD_CEILING enforced (sums apify_spend_ledger)
//
// Writes one spend ledger row per dispatch.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";

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

  // Monthly cap shared across all Apify usage (per-line + CruiseMapper).
  const monthly = await monthlySpendUsd(db);
  const cap = parseFloat(process.env.APIFY_MONTHLY_BUDGET_USD_CEILING ?? "500");
  if (monthly >= cap) {
    await sendOperatorAlert({
      severity: "high",
      signal: "apify_monthly_budget_exhausted",
      detail: `Apify monthly budget cap of $${cap} reached ($${monthly.toFixed(2)}). CruiseMapper itinerary refresh skipped.`,
      payload: { monthly_spend_usd: monthly, surface: "cruisemapper_itinerary" },
    });
    return skip("monthly_budget_exhausted", `monthly cap $${cap} reached`);
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
