// BP40 §33.8 — price-watch types.
//
// Mirrors the price_watches table from BP33 (§33.8.1 migration). Used by
// API routes, threshold evaluator, and Inngest job.

import type { CruiseLineCode, CabinClass, SailingKey } from "@/lib/pricing/types";

export type ThresholdKind = "dollar_drop" | "percent_drop" | "either";
export type WatchStatus = "active" | "triggered" | "paused" | "expired" | "cancelled";

export interface PriceWatch {
  watch_id: string;
  tenant_id: string;
  subscriber_user_id: string;
  booking_id: string | null;
  cruise_line: CruiseLineCode | string;
  ship: string;
  sail_date: string;        // ISO YYYY-MM-DD
  departure_port: string;
  cabin_class: CabinClass;
  baseline_price: number;
  baseline_currency: string;
  baseline_set_at: string;
  threshold_kind: ThresholdKind;
  dollar_threshold: number | null;
  percent_threshold: number | null;
  status: WatchStatus;
  triggered_at: string | null;
  notified_at: string | null;
  created_at: string;
}

export interface PriceAmount {
  amount: number;
  currency: string;
}

/** Convert a watch row into its composite SailingKey for cache lookups. */
export function sailingKeyForWatch(w: Pick<PriceWatch, "cruise_line" | "ship" | "sail_date" | "departure_port">): Pick<SailingKey, "line" | "ship" | "sailDate" | "departurePort"> {
  return {
    line: w.cruise_line as SailingKey["line"],
    ship: w.ship,
    sailDate: w.sail_date,
    departurePort: w.departure_port,
  };
}
