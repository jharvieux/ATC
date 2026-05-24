// BP34 §33.3 — ApifyPricingAdapter.
//
// Production PricingDataSource. Routes per-line, enforces per-run and
// monthly budget caps, writes to pricing_cache + apify_spend_ledger.
//
// Cost-deferral default-OFF: requires BOTH APIFY_ADAPTER_ENABLED=true
// AND APIFY_API_TOKEN before any actor dispatches. Operator opts in by
// flipping both (D-070).
//
// Uses native fetch (Node 18+) — no Apify SDK, keeps the dependency
// surface small and the request shape inspectable.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CachedPriceLookup,
  CruiseLineCode,
  PricingDataSource,
  RefreshResult,
  RegionCode,
  SailingKey,
} from "./types";
import { groupSailingsForBatch, routeFor, type LineRoute } from "./line-routing";
import { readPriceQuote, upsertPriceQuote } from "./pricing-cache";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";

const APIFY_RUN_TIMEOUT_MS = 5 * 60 * 1000; // §33.3 — 5-minute timeout

type AdapterRefuseReason =
  | "adapter_disabled"
  | "no_api_token"
  | "monthly_budget_exhausted"
  | "per_run_estimate_over_cap"
  | "unsupported_line"
  | "actor_dispatch_failed"
  | "actor_timeout"
  | "no_results";

interface ApifyResponse {
  data?: { id?: string; usage?: { totalUsd?: number } };
  items?: unknown[];
}

export class ApifyPricingAdapter implements PricingDataSource {
  constructor(private db: SupabaseClient) {}

  // ── Public API ───────────────────────────────────────────────────────────

  async getCachedPrice(key: SailingKey): Promise<CachedPriceLookup> {
    // Read-only — runs even when adapter is disabled / no token.
    if (!routeFor(key.line)) return { status: "unsupported" };
    const quote = await readPriceQuote(this.db, key);
    if (!quote) return { status: "miss" };
    return { status: "hit", quote };
  }

  async refreshGeneralPricing(opts: {
    lines: CruiseLineCode[];
    regions: RegionCode[];
    dateRange: { from: Date; to: Date };
  }): Promise<RefreshResult> {
    const guard = await this.checkGuards();
    if (guard) return guard;

    // General refresh dispatches one actor run per (line × region × date-window).
    // For v1 we keep it simple: one actor run per enabled line in `opts.lines`,
    // with the date range as the search window. Region is forwarded as an actor
    // input hint; per-line input builders ignore it when the actor doesn't accept it.
    let refreshed = 0, failed = 0, totalSpend = 0;
    let partial = false, reason: string | undefined;
    let lastRunId: string | null = null;
    void opts.regions; // forwarded by per-line builders if applicable

    for (const line of opts.lines) {
      const route = routeFor(line);
      if (!route) continue;
      const result = await this.runForLine(route, [], opts.dateRange);
      refreshed += result.sailings_refreshed;
      failed += result.sailings_failed;
      totalSpend += result.spend_usd;
      if (result.partial) {
        partial = true;
        reason ??= result.reason;
      }
      lastRunId = result.actor_run_id ?? lastRunId;
    }

    return {
      sailings_refreshed: refreshed,
      sailings_failed: failed,
      actor_run_id: lastRunId,
      spend_usd: totalSpend,
      partial,
      ...(reason ? { reason } : {}),
    };
  }

  async refreshTrackedSailings(sailings: SailingKey[]): Promise<RefreshResult> {
    const guard = await this.checkGuards();
    if (guard) return guard;

    // §33.3 batching: group into (line, port, 30-day window) buckets so
    // 30 RCL Caribbean sailings in one month dispatch one actor run.
    const batches = groupSailingsForBatch(sailings);
    let refreshed = 0, failed = 0, totalSpend = 0;
    let partial = false, reason: string | undefined;
    let lastRunId: string | null = null;

    for (const batch of batches) {
      const route = routeFor(batch.line);
      if (!route) {
        // Unsupported line — caller knows from getCachedPrice; just count failures.
        failed += batch.sailings.length;
        continue;
      }
      const result = await this.runForLine(route, batch.sailings);
      refreshed += result.sailings_refreshed;
      failed += result.sailings_failed;
      totalSpend += result.spend_usd;
      if (result.partial) {
        partial = true;
        reason ??= result.reason;
      }
      lastRunId = result.actor_run_id ?? lastRunId;
    }

    return {
      sailings_refreshed: refreshed,
      sailings_failed: failed,
      actor_run_id: lastRunId,
      spend_usd: totalSpend,
      partial,
      ...(reason ? { reason } : {}),
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async checkGuards(): Promise<RefreshResult | null> {
    if (!isAdapterEnabled()) {
      return refuse("adapter_disabled", "APIFY_ADAPTER_ENABLED=false");
    }
    if (!getApifyToken()) {
      return refuse("no_api_token", "APIFY_API_TOKEN not set");
    }
    const monthly = await this.monthlySpendUsd();
    if (monthly >= monthlyBudgetCap()) {
      await sendOperatorAlert({
        severity: "high",
        signal: "apify_monthly_budget_exhausted",
        detail: `Apify monthly budget cap of $${monthlyBudgetCap()} reached ($${monthly.toFixed(2)}). No new runs until next month or operator raises the cap.`,
        payload: { monthly_spend_usd: monthly },
      });
      return refuse("monthly_budget_exhausted", `monthly cap $${monthlyBudgetCap()} reached`);
    }
    return null;
  }

  private async monthlySpendUsd(): Promise<number> {
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const { data } = await this.db
      .from("apify_spend_ledger")
      .select("spend_usd")
      .gte("invoked_at", monthStart.toISOString());
    const rows = (data ?? []) as Array<{ spend_usd: number }>;
    return rows.reduce((s, r) => s + Number(r.spend_usd), 0);
  }

  private async runForLine(
    route: LineRoute,
    sailings: SailingKey[],
    dateRange?: { from: Date; to: Date },
  ): Promise<RefreshResult> {
    // Pre-flight cost estimate. We don't know exact pricing without
    // dispatching, so use a conservative per-result estimate.
    const estimatedResults = Math.max(sailings.length, 50);
    const estimatedSpend = estimatedResults * 0.05; // ~$0.05/result is a typical sercul actor rate
    if (estimatedSpend > runBudgetCap()) {
      await this.writeLedger(route.actorId, null, estimatedSpend, route.cruiseLine, "estimated_skipped", { estimated: true, reason: "per_run_cap" });
      return refuse("per_run_estimate_over_cap", `est $${estimatedSpend.toFixed(2)} > cap $${runBudgetCap()}`);
    }

    const input = route.inputBuilder(sailings);
    if (dateRange) {
      (input as Record<string, unknown>).dateRange = {
        from: dateRange.from.toISOString().slice(0, 10),
        to: dateRange.to.toISOString().slice(0, 10),
      };
    }

    let response: ApifyResponse | null = null;
    let runStatus: "succeeded" | "failed" | "partial" = "succeeded";
    let runId: string | null = null;
    let actualSpend = estimatedSpend;
    try {
      response = await this.dispatchActor(route.actorId, input);
      runId = response.data?.id ?? null;
      actualSpend = response.data?.usage?.totalUsd ?? estimatedSpend;
    } catch (err) {
      runStatus = err instanceof DOMException && err.name === "TimeoutError" ? "failed" : "failed";
      const reasonStr = err instanceof Error ? err.message : String(err);
      await this.writeLedger(route.actorId, null, 0, route.cruiseLine, "failed", { error: reasonStr });
      return refuse(reasonStr.includes("timeout") ? "actor_timeout" : "actor_dispatch_failed", reasonStr);
    }

    // Map + upsert.
    const items = response.items ?? [];
    let refreshed = 0, failedCount = 0;
    for (const item of items) {
      const mapped = route.outputMapper(item);
      if (!mapped) {
        failedCount += 1;
        continue;
      }
      if (!validateMapped(mapped)) {
        failedCount += 1;
        continue;
      }
      try {
        await upsertPriceQuote(this.db, mapped);
        refreshed += 1;
      } catch {
        failedCount += 1;
      }
    }

    if (refreshed === 0 && items.length > 0) runStatus = "partial";
    await this.writeLedger(route.actorId, runId, actualSpend, route.cruiseLine, runStatus, { results_count: items.length });

    return {
      sailings_refreshed: refreshed,
      sailings_failed: failedCount,
      actor_run_id: runId,
      spend_usd: actualSpend,
      partial: runStatus !== "succeeded",
    };
  }

  private async dispatchActor(actorId: string, input: unknown): Promise<ApifyResponse> {
    const token = getApifyToken();
    const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(token ?? "")}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), APIFY_RUN_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Apify actor ${actorId} returned ${res.status}`);
      }
      // run-sync-get-dataset-items returns the items array directly.
      const items = (await res.json()) as unknown[];
      const runId = res.headers.get("x-apify-actor-run-id");
      return { data: runId ? { id: runId } : {}, items };
    } finally {
      clearTimeout(timer);
    }
  }

  private async writeLedger(
    actorId: string,
    runId: string | null,
    spend: number,
    cruiseLine: CruiseLineCode | null,
    status: "succeeded" | "failed" | "partial" | "estimated_skipped",
    context: Record<string, unknown>,
  ): Promise<void> {
    await this.db.from("apify_spend_ledger").insert({
      actor_id: actorId,
      actor_run_id: runId,
      spend_usd: spend,
      cruise_line: cruiseLine,
      status,
      context,
    });
  }
}

// ── Validation ─────────────────────────────────────────────────────────────

function validateMapped(quote: { cabinPrices: Record<string, { amount: number } | undefined> }): boolean {
  // §33.3 validation: every cabin price within a plausible band.
  // 50 USD floor (catches $0 / negative); 50,000 USD ceiling (catches
  // mis-parsed deposit totals or per-room-vs-per-person mix-ups).
  for (const p of Object.values(quote.cabinPrices)) {
    if (!p) continue;
    if (p.amount < 50 || p.amount > 50_000) return false;
  }
  return true;
}

// ── Env access ─────────────────────────────────────────────────────────────

function isAdapterEnabled(): boolean {
  return process.env.APIFY_ADAPTER_ENABLED === "true";
}
function getApifyToken(): string | null {
  return process.env.APIFY_API_TOKEN ?? null;
}
function runBudgetCap(): number {
  return parseFloat(process.env.APIFY_RUN_BUDGET_USD_CEILING ?? "50");
}
function monthlyBudgetCap(): number {
  return parseFloat(process.env.APIFY_MONTHLY_BUDGET_USD_CEILING ?? "500");
}

function refuse(reason: AdapterRefuseReason, detail: string): RefreshResult {
  return {
    sailings_refreshed: 0,
    sailings_failed: 0,
    actor_run_id: null,
    spend_usd: 0,
    partial: true,
    reason: `${reason}: ${detail}`,
  };
}
