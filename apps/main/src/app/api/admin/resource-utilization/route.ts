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
import { parseBigIntCol, buildDailyArray, aggregateByModel, aggregateApifyByCruiseLine, sortTenantsByProximity, type DailyRow, type ModelRow, type TenantRow, type ApifyCruiseLineRow } from "./aggregations";
import { fetchRagEmbeddingRows, periodStartIso } from "./rag-fetch";

const RESEND_PRICE_KEY = "resend_cost_per_email_cents";
// Resend Hobby tier: $1.90/1k emails = 0.19¢ each. Stored as 19 = 0.19¢
// (fractional-cent precision: stored value ÷ 100 = ¢/email).
const RESEND_DEFAULT = 19;

const APIFY_BUDGET_KEY = "apify_monthly_budget_usd";

function currentBillingPeriod(): string {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return `[${start},${end})`;
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
        const periodStart = periodStartIso(period);

        const ragRowsPromise = fetchRagEmbeddingRows(thirtyDaysAgo, periodStart);

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
          apifyLedgerResult,
          apifyBudgetResult,
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
          db.from("apify_spend_ledger").select("invoked_at, spend_usd, cruise_line").gte("invoked_at", thirtyDaysAgo),
          db.from("platform_settings").select("value").eq("key", APIFY_BUDGET_KEY).maybeSingle(),
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
        if (apifyLedgerResult.error) throw new Error(`apify_spend_ledger read failed: ${apifyLedgerResult.error.message}`);
        if (apifyBudgetResult.error) throw new Error(`apify_budget read failed: ${apifyBudgetResult.error.message}`);

        recordQuery({ op: "select", table: "ai_call_log", row_count: (aiDailyResult.data?.length ?? 0) + (modelBreakdownResult.data?.length ?? 0) });
        recordQuery({ op: "select", table: "email_log", row_count: emailDailyResult.data?.length ?? 0 });
        recordQuery({ op: "select", table: "weather_usage_metrics", row_count: weatherHistoryResult.data?.length ?? 0 });
        recordQuery({ op: "select", table: "tenant_usage_metrics", row_count: tenantMetricsResult.data?.length ?? 0 });
        recordQuery({ op: "select", table: "tenants", row_count: tenantsResult.data?.length ?? 0 });
        recordQuery({ op: "select", table: "apify_spend_ledger", row_count: apifyLedgerResult.data?.length ?? 0 });

        const resendRate = parseBigIntCol((resendPriceResult.data as { value?: unknown } | null)?.value ?? RESEND_DEFAULT);

        const apifyLedgerRows = apifyLedgerResult.data as Array<{ invoked_at: string; spend_usd: number; cruise_line: string | null }>;

        const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
        const apifySpendUsdPeriod = apifyLedgerRows
          .filter((r) => r.invoked_at >= monthStart)
          .reduce((s, r) => s + Number(r.spend_usd), 0);

        const rawApifyBudget = (apifyBudgetResult.data as { value?: unknown } | null)?.value;
        const parsedApifyBudget = rawApifyBudget != null ? parseFloat(String(rawApifyBudget)) : NaN;
        const apifyMonthlyBudgetUsd =
          Number.isFinite(parsedApifyBudget) && parsedApifyBudget > 0
            ? parsedApifyBudget
            : (parseFloat(process.env.APIFY_MONTHLY_BUDGET_USD_CEILING ?? "500") || 500);

        const apifyByCruiseLine: ApifyCruiseLineRow[] = aggregateApifyByCruiseLine(apifyLedgerRows);

        // Merge rag embedding rows into the AI cost streams so the existing
        // chart + table render embeddings alongside chat spend. Failure on
        // the rag side returns empty arrays + an empty tenant map (see
        // fetchRagEmbeddingRows) so this never breaks the dashboard.
        const ragRows = await ragRowsPromise;
        recordQuery({ op: "select", table: "rag_ai_call_log", row_count: ragRows.daily.length + ragRows.byModel.length });

        const daily: DailyRow[] = buildDailyArray(
          [
            ...(aiDailyResult.data as Array<{ created_at: string; cost_estimate_cents: unknown }>),
            ...ragRows.daily,
          ],
          emailDailyResult.data as Array<{ sent_at: string | null }>,
          weatherHistoryResult.data as Array<{ metric_date: string; requests_count: number }>,
          new Date(),
          apifyLedgerRows,
        );

        const modelBreakdown: ModelRow[] = aggregateByModel([
          ...(modelBreakdownResult.data as Array<{ vendor: string; model: string; input_tokens: number; output_tokens: number; cost_estimate_cents: unknown }>),
          ...ragRows.byModel,
        ]);

        const tenantInfoMap = new Map<string, { slug: string; display_name: string }>();
        for (const t of tenantsResult.data as Array<{ id: string; slug: string; display_name: string }>) {
          tenantInfoMap.set(t.id, { slug: t.slug, display_name: t.display_name });
        }

        const tenantProximity: TenantRow[] = sortTenantsByProximity(
          (tenantMetricsResult.data as Array<{
            tenant_id: string;
            ai_cost_cents: unknown;
            ai_cost_limit_state: string;
            email_sent_count: number;
            email_volume_limit_state: string;
          }>).map((m) => {
            const info = tenantInfoMap.get(m.tenant_id) ?? { slug: m.tenant_id, display_name: "—" };
            // Surface tenant-attributed embedding cost (display only — the
            // cost-limit state itself is computed by main's enforcement layer
            // which doesn't yet know about embedding spend; tracked in #689).
            const ragEmbeddingCents = ragRows.tenantPeriod.get(m.tenant_id) ?? 0;
            return {
              tenant_id: m.tenant_id,
              slug: info.slug,
              display_name: info.display_name,
              ai_cost_cents: parseBigIntCol(m.ai_cost_cents) + ragEmbeddingCents,
              ai_cost_limit_state: m.ai_cost_limit_state,
              email_sent_count: m.email_sent_count,
              email_volume_limit_state: m.email_volume_limit_state,
            };
          }),
        );

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
            apify_spend_usd_period: apifySpendUsdPeriod,
            apify_monthly_budget_usd: apifyMonthlyBudgetUsd,
          },
          daily,
          model_breakdown: modelBreakdown,
          tenant_proximity: tenantProximity,
          apify_by_line: apifyByCruiseLine,
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

  let body: { resend_cost_per_email_cents?: unknown; apify_monthly_budget_usd?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const result: Record<string, number> = {};

  if ("resend_cost_per_email_cents" in body) {
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
      result.resend_rate = value;
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  }

  if ("apify_monthly_budget_usd" in body) {
    const value = body.apify_monthly_budget_usd;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return Response.json({ error: "apify_monthly_budget_usd must be a positive number" }, { status: 400 });
    }
    try {
      await withPlatformAdminAudit(
        {
          admin_user_id: adminUserId,
          reason: "apify_budget_update",
          operation: "apify_budget_update",
          reason_detail: `apify_budget_usd=${value}`,
        },
        async (db) => {
          await safeAwait(
            db.from("platform_settings").upsert(
              {
                key: APIFY_BUDGET_KEY,
                value: value as unknown as Record<string, unknown>,
                description: "Apify monthly spend budget cap in USD. Overrides APIFY_MONTHLY_BUDGET_USD_CEILING env var when set.",
              },
              { onConflict: "key" },
            ),
            "platform_settings.upsert.apify_budget",
          );
          return null;
        },
      );
      result.apify_monthly_budget_usd = value;
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  }

  if (Object.keys(result).length === 0) {
    return Response.json({ error: "no_recognized_fields" }, { status: 400 });
  }

  return Response.json({ ok: true, ...result });
}
