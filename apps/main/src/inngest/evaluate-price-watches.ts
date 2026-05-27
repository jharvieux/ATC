// BP40 §33.8.3 — Daily price-watch evaluator.
//
// Cron: 04:00 UTC. Runs AFTER BP35's monthly itinerary cron (03:00 UTC
// on the 1st of every month) so refreshed pricing flows in before the
// daily evaluation. Well before user-facing daily traffic.
//
// Flow (§33.8.3 correctness requirements):
//   0. EXPIRE FIRST. Transition any watches whose sail_date is in the
//      past to status='expired' before doing any other work — past
//      sailings should be neither refreshed (wasted Apify cost) nor
//      evaluated.
//   1. SELECT all remaining price_watches WHERE status='active'.
//   2. Group by SailingKey, batch-refresh via BP34's PricingDataSource
//      (one actor run per (line, port, month) bucket regardless of how
//      many watches reference it).
//   3. For each watch, read the now-refreshed pricing_cache row. APPLY
//      THE FRESHNESS GATE: only watches whose cached price is `fresh`
//      (within PRICE_FRESHNESS_FRESH_HOURS) are evaluated. Stale /
//      expired cached prices (actor blocked, budget cap, uncovered line)
//      cause the watch to be skipped for this run — never triggered on
//      data that may not reflect a real, current price.
//   4. Notification: enqueued only when PRICE_WATCH_NOTIFICATIONS_ENABLED=true
//      (default false per cost-deferral). When off, status flips still
//      happen — the UI reflects reality even without sending email.

import { inngest } from "./client";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { ApifyPricingAdapter } from "@/lib/pricing/apify-pricing-adapter";
import { evaluateThreshold } from "@/lib/price-watches/evaluate-threshold";
import { isFresh, resolveFreshHours } from "@/lib/price-watches/freshness";
import { sailingKeyForWatch, type PriceWatch } from "@/lib/price-watches/types";
import type { CabinClass, SailingKey } from "@/lib/pricing/types";
import { safeAwait } from "@/lib/db/safe-mutation";

export const evaluatePriceWatches = inngest.createFunction(
  {
    id: "evaluate-price-watches",
    triggers: [{ cron: "0 4 * * *" }],
  },
  async () => {
    if (process.env.STAGING_MODE === "true") return { skipped_for_staging: true };

    return withPlatformAdminAudit(
      {
        admin_user_id: "system-cron",
        reason: "external_pricing_refresh",
        operation: "evaluate_price_watches",
      },
      async (db, recordQuery) => {
        // §33.8.3 step 0 — expire-first sweep. Past sailings transition
        // to status='expired' before any refresh / evaluation so they
        // can't waste Apify cost or accidentally fire on a stale price.
        const todayIso = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        recordQuery({ op: "update", table: "price_watches" });
        const { data: expiredRows } = await db
          .from("price_watches")
          .update({ status: "expired" })
          .eq("status", "active")
          .lt("sail_date", todayIso)
          .select("watch_id");
        const expired_count = (expiredRows ?? []).length;

        recordQuery({ op: "select", table: "price_watches" });

        const { data: watchRows } = await db
          .from("price_watches")
          .select("*")
          .eq("status", "active")
          .limit(10_000);
        const watches = (watchRows ?? []) as PriceWatch[];
        if (watches.length === 0) {
          return { active_watches: 0, refreshed: 0, triggered: 0, notified: 0, expired: expired_count };
        }

        // De-dup sailing keys so we refresh each underlying price once.
        const keyMap = new Map<string, SailingKey>();
        for (const w of watches) {
          const partial = sailingKeyForWatch(w);
          // The pricing cache key requires durationNights; we use 0 here only
          // as a lookup placeholder. The cache layer keys on the composite
          // (line, ship, sailDate, departurePort, durationNights); for the
          // refresh batch the duration is a no-op upstream input.
          const k: SailingKey = { ...partial, durationNights: 0 };
          const id = `${k.line}|${k.ship}|${k.sailDate}|${k.departurePort}`;
          if (!keyMap.has(id)) keyMap.set(id, k);
        }

        const adapter = new ApifyPricingAdapter(db);
        const refresh = await adapter.refreshTrackedSailings([...keyMap.values()]);
        // refresh result includes spend, partials, etc. — useful in logs.

        let triggered = 0;
        let notified = 0;
        let skipped_stale = 0;
        const notificationsEnabled = process.env.PRICE_WATCH_NOTIFICATIONS_ENABLED === "true";

        // §33.8.3 freshness gate — only `fresh` prices may trigger a
        // watch. Threshold default per §33.10 is 72h; configurable via
        // PRICE_FRESHNESS_FRESH_HOURS so the operator can tighten or
        // loosen without a deploy.
        const freshHours = resolveFreshHours(process.env.PRICE_FRESHNESS_FRESH_HOURS);
        const nowMs = Date.now();

        for (const w of watches) {
          // Read current cached price for the specific cabin class.
          const { data: cachedRows } = await db
            .from("pricing_cache")
            .select("price_amount, price_currency, fetched_at")
            .eq("cruise_line", w.cruise_line)
            .eq("ship", w.ship)
            .eq("sail_date", w.sail_date)
            .eq("departure_port", w.departure_port)
            .eq("cabin_class", w.cabin_class)
            .limit(1);
          const row =
            ((cachedRows ?? []) as Array<{
              price_amount: number;
              price_currency: string;
              fetched_at: string | null;
            }>)[0] ?? null;
          let current: { amount: number; currency: string } | null = null;
          if (row) {
            // §33.8.3 freshness gate. If the cache miss happened (no row)
            // evaluateThreshold below returns 'no_action'; that's fine.
            // If we have a row but it's stale or expired, skip the watch
            // entirely — never compare against a price the actor failed
            // to refresh.
            if (!isFresh(row.fetched_at, nowMs, freshHours)) {
              skipped_stale += 1;
              continue;
            }
            const raw: unknown = row.price_amount;
            const dollars = typeof raw === "number" ? raw : Number(raw);
            current = { amount: dollars, currency: row.price_currency };
          }

          const outcome = evaluateThreshold(w, current);
          if (outcome.decision !== "trigger") continue;

          const nowIso = new Date().toISOString();
          const updatePayload: Record<string, unknown> = {
            status: "triggered",
            triggered_at: nowIso,
          };
          if (notificationsEnabled) {
            updatePayload.notified_at = nowIso;
          }
          await safeAwait(db.from("price_watches").update(updatePayload).eq("watch_id", w.watch_id), "price_watches.update");
          triggered += 1;

          if (notificationsEnabled) {
            // Enqueue notification. The full §23 notification template
            // wiring lands when operator flips the flag; the event is the
            // observable boundary.
            await inngest.send({
              name: "notifications.price_watch.triggered",
              data: {
                tenant_id: w.tenant_id,
                subscriber_user_id: w.subscriber_user_id,
                watch_id: w.watch_id,
                cruise_line: w.cruise_line,
                ship: w.ship,
                sail_date: w.sail_date,
                cabin_class: w.cabin_class as CabinClass,
                baseline_price: w.baseline_price,
                current_price: current?.amount ?? null,
                currency: w.baseline_currency,
                reason: outcome.reason,
              },
            });
            notified += 1;
          }
        }

        return {
          active_watches: watches.length,
          refreshed: refresh.sailings_refreshed,
          partial: refresh.partial,
          refresh_reason: refresh.reason ?? null,
          spend_usd: refresh.spend_usd,
          triggered,
          notified,
          skipped_stale,
          expired: expired_count,
          notifications_enabled: notificationsEnabled,
        };
      },
    );
  },
);
