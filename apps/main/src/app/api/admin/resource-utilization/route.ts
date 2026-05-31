// Resource utilization dashboard — platform admin.
//
// GET  returns 30-day daily cost breakdown, current-period summary,
//      per-model AI breakdown, tenant threshold proximity, and the
//      current pricing catalog (AI models + Resend per-email rate).
//      Wrapped in withPlatformAdminAudit so the read is audit-logged.
//
// PUT  body { resend_cost_per_email_cents: number } — updates the
//      Resend per-email rate in platform_settings. AI model pricing
//      is handled by the existing PUT /api/admin/ai-pricing endpoint.

import { assertPlatformAdmin, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { AI_PRICING_DEFAULTS, type ModelPricing } from "@/lib/ai/pricing";
import { safeAwait } from "@/lib/db/safe-mutation";

const RESEND_PRICE_KEY = "resend_cost_per_email_cents";
// Resend Hobby tier: $1.90/1k emails = 0.19¢ each. Stored as 19 = 0.19¢
// (fractional-cent precision: stored value ÷ 100 = ¢/email).
const RESEND_DEFAULT = 19;

function currentBillingPeriod(): string {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return `[${start},${end})`;
}

// Parse a Supabase BIGINT column (returned as string) to a JS number.
// Safe for dashboard aggregations — values stay well within MAX_SAFE_INTEGER.
function parseBigIntCol(v: unknown): number {
  if (typeof v === "number") return v;
  return parseInt(String(v), 10) || 0;
}

interface DailyRow {
  date: string;
  ai_cost_cents: number;
  email_count: number;
  weather_requests: number;
}

interface ModelRow {
  vendor: string;
  model: string;
  call_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
}

interface TenantRow {
  tenant_id: string;
  slug: string;
  display_name: string;
  ai_cost_cents: number;
  ai_cost_limit_state: string;
  email_sent_count: number;
  email_volume_limit_state: string;
}

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
        operation: "resource_utilization_read",
        reason_detail: "operator viewed platform resource utilization dashboard",
      },
      async (db, recordQuery) => {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const period = currentBillingPeriod();

        const [
          aiDailyResult,
          emailDailyResult,
          weatherHistoryResult,
          weatherTodayResult,
          modelBreakdownResult,
          tenantMetricsResult,
          tenantsResult,
          weatherCapResult,
          aiPricingResult,
          resendPriceResult,
        ] = await Promise.all([
          db.from("ai_call_log").select("created_at, cost_estimate_cents").gte("created_at", thirtyDaysAgo),
          db.from("email_log").select("sent_at").gte("sent_at", thirtyDaysAgo).in("status", ["sent", "delivered"]),
          db.from("weather_usage_metrics").select("metric_date, requests_count").gte("metric_date", thirtyDaysAgo.slice(0, 10)).order("metric_date", { ascending: true }),
          db.from("weather_usage_metrics").select("requests_count").eq("metric_date", new Date().toISOString().slice(0, 10)).maybeSingle(),
          db.from("ai_call_log").select("vendor, model, input_tokens, output_tokens, cost_estimate_cents").gte("created_at", thirtyDaysAgo),
          db.from("tenant_usage_metrics").select("tenant_id, ai_cost_cents, ai_cost_limit_state, email_sent_count, email_volume_limit_state").eq("billing_period", period),
          db.from("tenants").select("id, slug, display_name"),
          db.from("platform_settings").select("value").eq("key", "weather_daily_request_cap").maybeSingle(),
          db.from("platform_settings").select("value").eq("key", "ai_pricing_catalog").maybeSingle(),
          db.from("platform_settings").select("value").eq("key", RESEND_PRICE_KEY).maybeSingle(),
        ]);

        // Fail-closed: surface any DB error rather than silently returning zeros.
        if (aiDailyResult.error) throw new Error(`ai_call_log read failed: ${aiDailyResult.error.message}`);
        if (emailDailyResult.error) throw new Error(`email_log read failed: ${emailDailyResult.error.message}`);
        if (weatherHistoryResult.error) throw new Error(`weather_usage_metrics read failed: ${weatherHistoryResult.error.message}`);
        if (weatherTodayResult.error) throw new Error(`weather_usage_metrics today read failed: ${weatherTodayResult.error.message}`);
        if (modelBreakdownResult.error) throw new Error(`ai_call_log model breakdown failed: ${modelBreakdownResult.error.message}`);
        if (tenantMetricsResult.error) throw new Error(`tenant_usage_metrics read failed: ${tenantMetricsResult.error.message}`);
        if (tenantsResult.error) throw new Error(`tenants read failed: ${tenantsResult.error.message}`);
        if (weatherCapResult.error) throw new Error(`weather cap read failed: ${weatherCapResult.error.message}`);
        if (aiPricingResult.error) throw new Error(`ai_pricing_catalog read failed: ${aiPricingResult.error.message}`);
        if (resendPriceResult.error) throw new Error(`resend_price read failed: ${resendPriceResult.error.message}`);

        recordQuery({ op: "select", table: "ai_call_log", row_count: (aiDailyResult.data?.length ?? 0) + (modelBreakdownResult.data?.length ?? 0) });
        recordQuery({ op: "select", table: "email_log", row_count: emailDailyResult.data?.length ?? 0 });
        recordQuery({ op: "select", table: "weather_usage_metrics", row_count: weatherHistoryResult.data?.length ?? 0 });
        recordQuery({ op: "select", table: "tenant_usage_metrics", row_count: tenantMetricsResult.data?.length ?? 0 });
        recordQuery({ op: "select", table: "tenants", row_count: tenantsResult.data?.length ?? 0 });

        // Aggregate AI costs per day.
        const aiByDay = new Map<string, number>();
        for (const row of aiDailyResult.data as Array<{ created_at: string; cost_estimate_cents: unknown }>) {
          const day = row.created_at.slice(0, 10);
          aiByDay.set(day, (aiByDay.get(day) ?? 0) + parseBigIntCol(row.cost_estimate_cents));
        }

        // Aggregate email counts per day.
        const emailByDay = new Map<string, number>();
        for (const row of emailDailyResult.data as Array<{ sent_at: string | null }>) {
          if (!row.sent_at) continue;
          const day = row.sent_at.slice(0, 10);
          emailByDay.set(day, (emailByDay.get(day) ?? 0) + 1);
        }

        // Weather per day.
        const weatherByDay = new Map<string, number>();
        for (const row of weatherHistoryResult.data as Array<{ metric_date: string; requests_count: number }>) {
          weatherByDay.set(row.metric_date, row.requests_count);
        }

        const resendRate = parseBigIntCol((resendPriceResult.data as { value?: unknown } | null)?.value ?? RESEND_DEFAULT);

        // Build sorted 30-day array, filling zeros for days with no activity.
        const today = new Date();
        const daily: DailyRow[] = [];
        for (let i = 29; i >= 0; i--) {
          const d = new Date(today);
          d.setUTCDate(today.getUTCDate() - i);
          const dateStr = d.toISOString().slice(0, 10);
          daily.push({
            date: dateStr,
            ai_cost_cents: aiByDay.get(dateStr) ?? 0,
            email_count: emailByDay.get(dateStr) ?? 0,
            weather_requests: weatherByDay.get(dateStr) ?? 0,
          });
        }

        // Per-model breakdown — aggregate raw rows.
        const modelMap = new Map<string, ModelRow>();
        for (const row of modelBreakdownResult.data as Array<{
          vendor: string;
          model: string;
          input_tokens: number;
          output_tokens: number;
          cost_estimate_cents: unknown;
        }>) {
          const key = `${row.vendor}:${row.model}`;
          const existing = modelMap.get(key) ?? { vendor: row.vendor, model: row.model, call_count: 0, input_tokens: 0, output_tokens: 0, cost_cents: 0 };
          existing.call_count++;
          existing.input_tokens += row.input_tokens;
          existing.output_tokens += row.output_tokens;
          existing.cost_cents += parseBigIntCol(row.cost_estimate_cents);
          modelMap.set(key, existing);
        }
        const modelBreakdown = Array.from(modelMap.values()).sort((a, b) => b.cost_cents - a.cost_cents);

        // Tenant proximity — join metrics with tenant display info.
        const tenantInfoMap = new Map<string, { slug: string; display_name: string }>();
        for (const t of tenantsResult.data as Array<{ id: string; slug: string; display_name: string }>) {
          tenantInfoMap.set(t.id, { slug: t.slug, display_name: t.display_name });
        }

        const stateSeverity: Record<string, number> = { hard: 3, soft2: 2, soft1: 1, ok: 0 };
        const tenantProximity: TenantRow[] = (
          tenantMetricsResult.data as Array<{
            tenant_id: string;
            ai_cost_cents: unknown;
            ai_cost_limit_state: string;
            email_sent_count: number;
            email_volume_limit_state: string;
          }>
        )
          .map((m) => {
            const info = tenantInfoMap.get(m.tenant_id) ?? { slug: m.tenant_id, display_name: "—" };
            return {
              tenant_id: m.tenant_id,
              slug: info.slug,
              display_name: info.display_name,
              ai_cost_cents: parseBigIntCol(m.ai_cost_cents),
              ai_cost_limit_state: m.ai_cost_limit_state,
              email_sent_count: m.email_sent_count,
              email_volume_limit_state: m.email_volume_limit_state,
            };
          })
          .sort((a, b) => {
            const sev = (stateSeverity[b.ai_cost_limit_state] ?? 0) - (stateSeverity[a.ai_cost_limit_state] ?? 0);
            if (sev !== 0) return sev;
            return b.ai_cost_cents - a.ai_cost_cents;
          });

        // Platform-wide current-period summary.
        const totalAiCost = tenantProximity.reduce((s, t) => s + t.ai_cost_cents, 0);
        const totalEmailCount = tenantProximity.reduce((s, t) => s + t.email_sent_count, 0);
        const weatherCap = parseBigIntCol((weatherCapResult.data as { value?: unknown } | null)?.value ?? 8000);
        const weatherToday = (weatherTodayResult.data as { requests_count?: number } | null)?.requests_count ?? 0;
        const weatherMonth = (weatherHistoryResult.data as Array<{ requests_count: number }>).reduce(
          (s, r) => s + r.requests_count,
          0,
        );

        const catalogOverride = (aiPricingResult.data as { value?: unknown } | null)?.value as
          | Record<string, ModelPricing>
          | undefined;
        const effectivePricing = { ...AI_PRICING_DEFAULTS, ...(catalogOverride ?? {}) };

        return {
          summary: {
            period,
            total_ai_cost_cents: totalAiCost,
            total_email_count: totalEmailCount,
            total_email_cost_cents: Math.round(totalEmailCount * resendRate),
            weather_requests_today: weatherToday,
            weather_requests_month: weatherMonth,
            weather_cap: weatherCap,
          },
          daily,
          model_breakdown: modelBreakdown,
          tenant_proximity: tenantProximity,
          pricing: {
            ai: effectivePricing,
            resend_rate: resendRate,
          },
        };
      },
    );
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function PUT(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdmin(req)).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  let body: { resend_cost_per_email_cents?: unknown };
  try {
    body = (await req.json()) as { resend_cost_per_email_cents?: unknown };
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const value = body.resend_cost_per_email_cents;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return Response.json({ error: "resend_cost_per_email_cents must be a non-negative number" }, { status: 400 });
  }

  try {
    await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: "resend_pricing_update",
        operation: "resend_pricing_update",
        reason_detail: `resend_rate=${value}`,
      },
      async (db) => {
        await safeAwait(
          db.from("platform_settings").upsert(
            {
              key: RESEND_PRICE_KEY,
              value: value as unknown as Record<string, unknown>,
              description: "Resend cost per sent email in fractional cents × 100. Used for cost dashboard estimates only.",
            },
            { onConflict: "key" },
          ),
          "platform_settings.upsert.resend_price",
        );
        return null;
      },
    );
    return Response.json({ ok: true, resend_rate: value });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
