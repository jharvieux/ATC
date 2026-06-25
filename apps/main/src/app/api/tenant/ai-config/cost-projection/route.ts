// §27.12 — AI cost projection for the tenant /settings/ai-mode page.
//
// Reads `tenant_usage_metrics.ai_cost_cents` for the current billing
// period and projects month-end spend by linear extrapolation from
// elapsed days. No per-mode breakdown — historical data isn't deep
// enough to make per-mode multipliers honest. The page shows ONE
// shared current-period spend block above the mode cards.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { fromCents, type Cents } from "@/lib/money";
import { dbErrorResponse } from "@/lib/api/db-error-response";

function currentPeriodRange(): { rangeLiteral: string; periodStart: Date; periodEnd: Date } {
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const rangeLiteral = `[${periodStart.toISOString().slice(0, 10)},${periodEnd.toISOString().slice(0, 10)})`;
  return { rangeLiteral, periodStart, periodEnd };
}

export async function GET(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await assertPermission(req, { resource: "TenantUsage", action: "read" });
  } catch (err) {
    return respondToAuthError(err);
  }
  const db = tenantClient(auth.ctx);

  const { rangeLiteral, periodStart, periodEnd } = currentPeriodRange();
  const { data, error } = await db
    .from("tenant_usage_metrics")
    .select("ai_cost_cents")
    .eq("tenant_id", auth.ctx.tenant_id)
    .eq("billing_period", rangeLiteral)
    .maybeSingle();

  if (error) return dbErrorResponse(error);

  // ai_cost_cents is BIGINT in DB; Supabase returns string or number depending
  // on driver settings — coerce to BigInt for safe arithmetic.
  const rawCents = (data as { ai_cost_cents?: number | string | bigint } | null)?.ai_cost_cents ?? 0n;
  const mtdCents = typeof rawCents === "bigint" ? rawCents : BigInt(rawCents);

  // Projection: linear extrapolation by days elapsed.
  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  const totalDaysInMonth = Math.round((periodEnd.getTime() - periodStart.getTime()) / msPerDay);
  // +1 so the current day counts; avoid 0-divide on the 1st-of-month edge.
  const daysElapsed = Math.max(1, Math.round((now.getTime() - periodStart.getTime()) / msPerDay));
  const projectedCents =
    daysElapsed > 0
      ? (mtdCents * BigInt(totalDaysInMonth)) / BigInt(daysElapsed)
      : mtdCents;

  return Response.json({
    period_start: periodStart.toISOString().slice(0, 10),
    period_end: periodEnd.toISOString().slice(0, 10),
    days_elapsed: daysElapsed,
    total_days_in_month: totalDaysInMonth,
    current_period_spend: fromCents(mtdCents as Cents),
    projected_month_end_spend: fromCents(projectedCents as Cents),
    currency: "USD",
  });
}
