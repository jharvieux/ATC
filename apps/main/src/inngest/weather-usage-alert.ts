// §23.4 — Weather usage sustained-load operator alert.
//
// Runs daily at 04:30 UTC (after any midnight sweeps but well before
// most US/EU operator workdays). If usage for the last 3 *completed*
// days was ≥ 70% of the configured cap each day, emit a medium-severity
// operator alert so the operator has lead time to raise the cap or
// upgrade off Open-Meteo's free tier before users start losing weather
// from their pre-cruise emails.
//
// IDEMPOTENCY:
//   We track `weather_usage_alert_last_sent_date` in platform_settings.
//   If the row's value equals today's UTC date, the cron exits without
//   re-sending. The value is bumped only AFTER a successful alert send,
//   so a transient Resend failure doesn't suppress the next morning's
//   retry. Three-day sustained loads are rare enough that one alert per
//   day is the right cadence.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";
import { safeAwait } from "@/lib/db/safe-mutation";
import { parseDailyCap, FALLBACK_DAILY_CAP } from "@/lib/weather/parse-cap";

const SUSTAINED_THRESHOLD_PCT = 70;
const LOOKBACK_DAYS = 3;

interface UsageRow {
  metric_date: string;
  requests_count: number;
}

interface PlatformSettingRow {
  value: unknown;
}

export const weatherUsageAlert = inngest.createFunction(
  {
    id: "weather-usage-alert",
    triggers: [{ cron: "30 4 * * *" }],
  },
  async () => {
    const db = createServiceRoleClient();

    // Already alerted today? Bail. We throw on DB error rather than
    // silently treat as "not sent" — a flaky read here would otherwise
    // re-send the alert on every Inngest retry until the row was
    // readable again.
    const today = new Date().toISOString().slice(0, 10);
    const lastSentRes = await db
      .from("platform_settings")
      .select("value")
      .eq("key", "weather_usage_alert_last_sent_date")
      .maybeSingle<PlatformSettingRow>();
    if (lastSentRes.error) {
      throw new Error(`weather_usage_alert_last_sent_date read failed: ${lastSentRes.error.message}`);
    }
    if (lastSentRes.data && lastSentRes.data.value === today) {
      return { skipped: "already_sent_today" };
    }

    const capRes = await db
      .from("platform_settings")
      .select("value")
      .eq("key", "weather_daily_request_cap")
      .maybeSingle<PlatformSettingRow>();
    const cap = parseDailyCap(capRes.data?.value) ?? FALLBACK_DAILY_CAP;
    const threshold = Math.floor((cap * SUSTAINED_THRESHOLD_PCT) / 100);

    // Last LOOKBACK_DAYS *completed* days (excludes today, which is still
    // accumulating). For day-1 in production this returns < 3 rows and the
    // gate below short-circuits to "not enough data".
    const sinceDate = new Date();
    sinceDate.setUTCDate(sinceDate.getUTCDate() - LOOKBACK_DAYS);
    const sinceStr = sinceDate.toISOString().slice(0, 10);
    const yesterdayDate = new Date();
    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
    const yesterdayStr = yesterdayDate.toISOString().slice(0, 10);

    const histRes = await db
      .from("weather_usage_metrics")
      .select("metric_date, requests_count")
      .gte("metric_date", sinceStr)
      .lte("metric_date", yesterdayStr)
      .order("metric_date", { ascending: true });

    if (histRes.error) {
      throw new Error(`weather_usage_metrics read failed: ${histRes.error.message}`);
    }

    const rows = (histRes.data ?? []) as UsageRow[];
    if (rows.length < LOOKBACK_DAYS) {
      return { skipped: "insufficient_history", days: rows.length };
    }

    const sustained = rows.every((r) => r.requests_count >= threshold);
    if (!sustained) {
      return { sustained: false, threshold, days: rows.length };
    }

    await sendOperatorAlert({
      severity: "medium",
      signal: "weather_usage_sustained_high",
      detail:
        `Open-Meteo daily requests have been ≥ ${SUSTAINED_THRESHOLD_PCT}% of the configured ` +
        `cap (${cap}, threshold ${threshold}) for ${LOOKBACK_DAYS} consecutive days. ` +
        `Raise the cap or upgrade off the free tier before requests start being denied.`,
      payload: {
        cap,
        threshold_pct: SUSTAINED_THRESHOLD_PCT,
        last_n_days: rows,
      },
    });

    await safeAwait(
      db
        .from("platform_settings")
        .upsert(
          {
            key: "weather_usage_alert_last_sent_date",
            value: today,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "key" },
        ),
      "platform_settings.upsert.weather_usage_alert_last_sent_date",
    );

    return { sustained: true, alert_sent: true, threshold };
  },
);
