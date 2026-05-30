// §23.4 — Platform-admin weather usage + cap management.
//
// GET  → current cap, today's count, this month's count, 30-day series,
//        and a linear projection of "days until cap" for an upgrade-decision
//        hint.
// POST → update weather_daily_request_cap. Body: { cap: number }.
//        Validates 1 ≤ cap ≤ 10000 (Open-Meteo free-tier ceiling).
//
// Both gated by assertPlatformAdmin. The POST write goes through
// withPlatformAdminAudit for forensic record (cap changes are an operator
// decision worth auditing).

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertPlatformAdmin, PlatformAdminError } from "@/lib/auth/assert-platform-admin";

interface UsageRow {
  metric_date: string;
  requests_count: number;
  last_request_at: string | null;
}

interface PlatformSettingRow {
  value: unknown;
}

const FALLBACK_CAP = 8000;
const HISTORY_DAYS = 30;
const OPEN_METEO_CEILING = 10000;

export async function GET(req: Request): Promise<Response> {
  try {
    await assertPlatformAdmin(req);
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  const db = createServiceRoleClient();

  const capRes = await db
    .from("platform_settings")
    .select("value")
    .eq("key", "weather_daily_request_cap")
    .maybeSingle<PlatformSettingRow>();

  if (capRes.error) {
    return Response.json({ error: "cap_read_failed" }, { status: 500 });
  }
  const cap = parseCap(capRes.data?.value) ?? FALLBACK_CAP;

  const sinceDate = new Date();
  sinceDate.setUTCDate(sinceDate.getUTCDate() - (HISTORY_DAYS - 1));
  const sinceStr = sinceDate.toISOString().slice(0, 10);

  const histRes = await db
    .from("weather_usage_metrics")
    .select("metric_date, requests_count, last_request_at")
    .gte("metric_date", sinceStr)
    .order("metric_date", { ascending: true });

  if (histRes.error) {
    return Response.json({ error: "usage_read_failed" }, { status: 500 });
  }

  const rows = (histRes.data ?? []) as UsageRow[];
  const today = new Date().toISOString().slice(0, 10);
  const requestsToday = rows.find((r) => r.metric_date === today)?.requests_count ?? 0;
  const requestsThisMonth = rows
    .filter((r) => r.metric_date.startsWith(today.slice(0, 7)))
    .reduce((sum, r) => sum + r.requests_count, 0);

  // 7-day average gives a more stable "days until cap" hint than today's
  // partial count. Excludes today (still in progress).
  const recent7 = rows
    .filter((r) => r.metric_date !== today)
    .slice(-7)
    .map((r) => r.requests_count);
  const avg7 = recent7.length > 0
    ? recent7.reduce((s, n) => s + n, 0) / recent7.length
    : 0;

  return Response.json({
    cap,
    cap_ceiling: OPEN_METEO_CEILING,
    requests_today: requestsToday,
    requests_this_month: requestsThisMonth,
    daily_history: rows,
    avg_7d: Math.round(avg7),
    days_until_cap: avg7 > cap ? 0 : null,
  });
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
  if (!Number.isFinite(cap) || !Number.isInteger(cap) || cap < 1 || cap > OPEN_METEO_CEILING) {
    return Response.json(
      { error: "invalid_cap", hint: `cap must be an integer between 1 and ${OPEN_METEO_CEILING}` },
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

function parseCap(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}
