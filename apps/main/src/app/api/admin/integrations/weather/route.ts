// §23.4 — Platform-admin weather usage + cap management.
//
// GET  → current cap, today's count, this month's count, 30-day series,
//        7-day average.
// POST → update weather_daily_request_cap. Body: { cap: number }.
//        Validates 1 ≤ cap ≤ OPEN_METEO_FREE_TIER_CEILING.
//
// Both gated by assertPlatformAdmin. Both wrapped in withPlatformAdminAudit
// for forensic record — every cross-tenant admin op produces an audit_log
// row per §26.3a (matches legal-docs / retrieval-weights / abuse-overrides
// admin routes).

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdmin, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import {
  parseDailyCap,
  OPEN_METEO_FREE_TIER_CEILING,
  FALLBACK_DAILY_CAP,
} from "@/lib/weather/parse-cap";

interface UsageRow {
  metric_date: string;
  requests_count: number;
  last_request_at: string | null;
}

interface PlatformSettingRow {
  value: unknown;
}

const HISTORY_DAYS = 30;

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdmin(req)).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  try {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "platform_metrics_rollup",
        operation: "weather_usage_read",
        reason_detail: "admin viewed weather integration usage + cap",
      },
      async (db, recordQuery) => {
        const capRes = await db
          .from("platform_settings")
          .select("value")
          .eq("key", "weather_daily_request_cap")
          .maybeSingle<PlatformSettingRow>();
        recordQuery({ op: "select", table: "platform_settings", row_count: capRes.data ? 1 : 0 });
        if (capRes.error) throw new Error(`cap_read_failed: ${capRes.error.message}`);
        const cap = parseDailyCap(capRes.data?.value) ?? FALLBACK_DAILY_CAP;

        const sinceDate = new Date();
        sinceDate.setUTCDate(sinceDate.getUTCDate() - (HISTORY_DAYS - 1));
        const sinceStr = sinceDate.toISOString().slice(0, 10);

        const histRes = await db
          .from("weather_usage_metrics")
          .select("metric_date, requests_count, last_request_at")
          .gte("metric_date", sinceStr)
          .order("metric_date", { ascending: true });
        if (histRes.error) throw new Error(`usage_read_failed: ${histRes.error.message}`);

        const rows = (histRes.data ?? []) as UsageRow[];
        recordQuery({ op: "select", table: "weather_usage_metrics", row_count: rows.length });

        const today = new Date().toISOString().slice(0, 10);
        const requestsToday = rows.find((r) => r.metric_date === today)?.requests_count ?? 0;
        const requestsThisMonth = rows
          .filter((r) => r.metric_date.startsWith(today.slice(0, 7)))
          .reduce((sum, r) => sum + r.requests_count, 0);

        // 7-day average over the seven most recent COMPLETED days
        // (excluding today, which is still accumulating). Stable basis
        // for the upgrade hint.
        const recent7 = rows
          .filter((r) => r.metric_date !== today)
          .slice(-7)
          .map((r) => r.requests_count);
        const avg7 = recent7.length > 0
          ? recent7.reduce((s, n) => s + n, 0) / recent7.length
          : 0;

        return {
          cap,
          cap_ceiling: OPEN_METEO_FREE_TIER_CEILING,
          requests_today: requestsToday,
          requests_this_month: requestsThisMonth,
          daily_history: rows,
          avg_7d: Math.round(avg7),
        };
      },
    );
    return Response.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("cap_read_failed")) {
      return Response.json({ error: "cap_read_failed" }, { status: 500 });
    }
    if (msg.startsWith("usage_read_failed")) {
      return Response.json({ error: "usage_read_failed" }, { status: 500 });
    }
    throw e;
  }
}

export async function POST(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdmin(req)).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  let body: { cap?: unknown };
  try {
    body = (await req.json()) as { cap?: unknown };
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const cap = typeof body.cap === "number" ? body.cap : Number(body.cap);
  if (
    !Number.isFinite(cap) ||
    !Number.isInteger(cap) ||
    cap < 1 ||
    cap > OPEN_METEO_FREE_TIER_CEILING
  ) {
    return Response.json(
      { error: "invalid_cap", hint: `cap must be an integer between 1 and ${OPEN_METEO_FREE_TIER_CEILING}` },
      { status: 400 },
    );
  }

  await withPlatformAdminAudit(
    {
      admin_user_id: adminUserId,
      reason: "platform_setting_update",
      operation: "weather_daily_request_cap_update",
      reason_detail: `operator set weather_daily_request_cap=${cap}`,
    },
    async (db, recordQuery) => {
      const { error } = await db
        .from("platform_settings")
        .update({
          value: cap,
          updated_at: new Date().toISOString(),
        })
        .eq("key", "weather_daily_request_cap");
      recordQuery({ op: "update", table: "platform_settings", row_count: 1 });
      if (error) throw new Error(`platform_settings.update failed: ${error.message}`);
    },
  );

  return Response.json({ cap, ok: true });
}
