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

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwait } from "@/lib/db/safe-mutation";
import type {
  CachedPriceLookup,
  CruiseLineCode,
  PricingDataSource,
  RefreshResult,
  SailingKey,
} from "./types";
import { assertActorAllowed, groupSailingsForBatch, matchesAnyWatchedSailing, routeFor, type LineRoute } from "./line-routing";
import { readPriceQuote, upsertPriceQuote } from "./pricing-cache";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";
import { checkMonthlyBudget } from "./budget-priority";

const APIFY_RUN_TIMEOUT_MS = 5 * 60 * 1000; // §33.3 — 5-minute timeout

type AdapterRefuseReason =
  | "adapter_disabled"
  | "no_api_token"
  | "monthly_budget_exhausted"
  | "per_run_estimate_over_cap"
  | "unsupported_line"
  | "actor_dispatch_failed"
  | "actor_timeout"
  | "allowlist_violation"
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

  // D-088: refreshGeneralPricing was removed. General-pricing context for
  // the AI is now sourced from the DIY CruiseMapper scraper (no Apify
  // spend). The price-watch evaluator is the SOLE caller of Apify; it uses
  // refreshTrackedSailings below for sailings with an active watch.

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
    // §33.9.3 D-088 — tracked-sailings refresh is the SOLE Apify consumer
    // now. General-pricing was removed (DIY scraper replaces it). When
    // month-to-date spend hits the budget cap (DB override > env var),
    // tracked-sailings pauses for the rest of the month — subscriber watches
    // go un-refreshed but stay armed.
    const [monthly, capOverride] = await Promise.all([
      this.monthlySpendUsd(),
      this.readBudgetCapFromDb(),
    ]);
    const gate = checkMonthlyBudget(monthly, capOverride);
    if (gate.paused) {
      // monthly is Infinity when the spend-ledger read failed (fail-closed). A
      // DB-read incident needs different operator action than a real overrun, so
      // keep the two distinguishable — Infinity would otherwise serialize to a
      // null/$Infinity audit row that loses that signal.
      const spendKnown = Number.isFinite(monthly);
      await sendOperatorAlert({
        severity: "high",
        signal: "apify_monthly_budget_exhausted",
        detail: spendKnown
          ? `Apify monthly budget cap of $${gate.cap_usd.toFixed(2)} reached ($${monthly.toFixed(2)}). Tracked-sailings refresh paused — subscriber price-watch notifications will be skipped this run.`
          : `Apify spend-ledger read failed; pausing tracked-sailings refresh as a fail-closed precaution (cap $${gate.cap_usd.toFixed(2)}). Subscriber price-watch notifications will be skipped this run.`,
        payload: {
          monthly_spend_usd: spendKnown ? monthly : null,
          spend_read_failed: !spendKnown,
          cap_kind: "tracked_sailings",
        },
      });
      return refuse(
        "monthly_budget_exhausted",
        spendKnown ? `monthly cap $${gate.cap_usd.toFixed(2)} reached` : "spend-ledger read failed (fail-closed)",
      );
    }
    return null;
  }

  private async readBudgetCapFromDb(): Promise<number | undefined> {
    const { data, error } = await this.db
      .from("platform_settings")
      .select("value")
      .eq("key", "apify_monthly_budget_usd")
      .maybeSingle();
    if (error) {
      console.error(`[ApifyPricingAdapter] readBudgetCapFromDb failed — using env var cap: ${error.message}`);
      return undefined;
    }
    if (!data) return undefined;
    const v = parseFloat(String((data as { value?: unknown }).value));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  }

  private async monthlySpendUsd(): Promise<number> {
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const { data, error } = await this.db
      .from("apify_spend_ledger")
      .select("spend_usd")
      .gte("invoked_at", monthStart.toISOString());
    if (error) {
      // Fail closed: if we can't read spend, assume the cap is blown so the
      // budget gate pauses rather than dispatching an unmetered run (D-091).
      console.error(`[ApifyPricingAdapter] monthlySpendUsd read failed — pausing budget: ${error.message}`);
      return Infinity;
    }
    const rows = (data ?? []) as Array<{ spend_usd: number }>;
    return rows.reduce((s, r) => s + Number(r.spend_usd), 0);
  }

  private async runForLine(
    route: LineRoute,
    sailings: SailingKey[],
  ): Promise<RefreshResult> {
    // Pre-flight cost estimate. We don't know exact pricing without
    // dispatching, so use a conservative per-result estimate.
    const estimatedResults = Math.max(sailings.length, 50);
    const estimatedSpend = estimatedResults * 0.05; // ~$0.05/result is a typical sercul actor rate
    if (estimatedSpend > runBudgetCap()) {
      await this.writeLedger(route.actorId, null, estimatedSpend, route.cruiseLine, "estimated_skipped", { estimated: true, reason: "per_run_cap" });
      return refuse("per_run_estimate_over_cap", `est $${estimatedSpend.toFixed(2)} > cap $${runBudgetCap()}`);
    }

    const input = route.inputBuilder();

    let response: ApifyResponse | null = null;
    let runStatus: "succeeded" | "failed" | "partial" = "succeeded";
    let runId: string | null = null;
    let actualSpend: number;
    try {
      response = await this.dispatchActor(route.actorId, input);
      runId = response.data?.id ?? null;
      actualSpend = response.data?.usage?.totalUsd ?? estimatedSpend;
    } catch (err) {
      const reasonStr = err instanceof Error ? err.message : String(err);
      await this.writeLedger(route.actorId, null, 0, route.cruiseLine, "failed", { error: reasonStr });
      // D-090 Apify-5 — distinguish allowlist violations so the operator can
      // grep ledger rows for them; these indicate a code/config bug, not a
      // network failure.
      if (reasonStr.startsWith("apify_allowlist_violation")) {
        await sendOperatorAlert({
          severity: "high",
          signal: "apify_allowlist_violation",
          detail: reasonStr,
          payload: { actor_id: route.actorId, cruise_line: route.cruiseLine },
        });
        return refuse("allowlist_violation", reasonStr);
      }
      return refuse(reasonStr.includes("timeout") ? "actor_timeout" : "actor_dispatch_failed", reasonStr);
    }

    // Map + filter to watched sailings + upsert. D-088 Apify-4: the actor
    // dumps the whole market; we only cache items that belong to a watched
    // sailing. Any watched sailing that didn't appear in the response is
    // counted as a failure (no price found this run).
    const items = response.items ?? [];
    let refreshed = 0;
    const matchedKeys = new Set<string>();
    for (const item of items) {
      const mapped = route.outputMapper(item);
      if (!mapped) continue;
      if (!validateMapped(mapped)) continue;
      if (sailings.length > 0 && !matchesAnyWatchedSailing(mapped, sailings)) continue;
      try {
        await upsertPriceQuote(this.db, mapped);
        refreshed += 1;
        matchedKeys.add(sailingKeyStr(mapped.key));
      } catch {
        // upsert error counted below via the watched-set diff
      }
    }
    const failedCount = sailings.length > 0
      ? sailings.filter((s) => !matchedKeys.has(sailingKeyStr(s))).length
      : 0;

    if (refreshed === 0 && items.length > 0) runStatus = "partial";
    await this.writeLedger(route.actorId, runId, actualSpend, route.cruiseLine, runStatus, {
      results_count: items.length,
      watched_count: sailings.length,
      matched_count: refreshed,
    });

    return {
      sailings_refreshed: refreshed,
      sailings_failed: failedCount,
      actor_run_id: runId,
      spend_usd: actualSpend,
      partial: runStatus !== "succeeded",
    };
  }

  private async dispatchActor(actorId: string, input: unknown): Promise<ApifyResponse> {
    // D-090 Apify-5 — defense-in-depth: refuse any actor not on the
    // hardcoded allowlist before we send the token over the wire.
    assertActorAllowed(actorId);
    const token = getApifyToken();
    // D-091 P1 #2 — token in Authorization header, NOT URL query string.
    // URLs end up in proxy/CDN/APM logs and Node's fetch TypeError messages;
    // the Apify token is account-level so a single log-scrape exposes
    // unbounded spend. Apify accepts both auth methods.
    const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), APIFY_RUN_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token ?? ""}`,
        },
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
    await safeAwait(this.db.from("apify_spend_ledger").insert({
      actor_id: actorId,
      actor_run_id: runId,
      spend_usd: spend,
      cruise_line: cruiseLine,
      status,
      context,
    }), "apify_spend_ledger.insert");
  }
}

function sailingKeyStr(k: SailingKey): string {
  return `${k.line}|${k.ship}|${k.sailDate}|${k.departurePort}|${k.durationNights}`;
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
