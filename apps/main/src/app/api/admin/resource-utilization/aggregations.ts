// Pure aggregation helpers for the resource-utilization dashboard GET handler.
// Extracted so the bucketing, rollup, and sort invariants can be unit-tested
// without wiring the HTTP layer.

export interface DailyRow {
  date: string;
  ai_cost_cents: number;
  email_count: number;
  weather_requests: number;
  apify_spend_cents: number;
}

export interface ApifyCruiseLineRow {
  cruise_line: string | null;
  run_count: number;
  spend_usd: number;
}

export interface ModelRow {
  vendor: string;
  model: string;
  call_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
}

export interface TenantRow {
  tenant_id: string;
  slug: string;
  display_name: string;
  ai_cost_cents: number;
  ai_cost_limit_state: string;
  email_sent_count: number;
  email_volume_limit_state: string;
}

// Safe for dashboard aggregations — values stay well within MAX_SAFE_INTEGER.
export function parseBigIntCol(v: unknown): number {
  if (typeof v === "number") return v;
  return parseInt(String(v), 10) || 0;
}

// Builds a sorted 30-day array anchored on `today`, zero-filling days with no
// activity. Zero-fill is intentional: the chart must always render 30 points
// regardless of data density.
export function buildDailyArray(
  aiRows: Array<{ created_at: string; cost_estimate_cents: unknown }>,
  emailRows: Array<{ sent_at: string | null }>,
  weatherRows: Array<{ metric_date: string; requests_count: number }>,
  today: Date,
  apifyRows: Array<{ invoked_at: string; spend_usd: number }> = [],
): DailyRow[] {
  const aiByDay = new Map<string, number>();
  for (const row of aiRows) {
    const day = row.created_at.slice(0, 10);
    aiByDay.set(day, (aiByDay.get(day) ?? 0) + parseBigIntCol(row.cost_estimate_cents));
  }

  const emailByDay = new Map<string, number>();
  for (const row of emailRows) {
    if (!row.sent_at) continue;
    const day = row.sent_at.slice(0, 10);
    emailByDay.set(day, (emailByDay.get(day) ?? 0) + 1);
  }

  const weatherByDay = new Map<string, number>();
  for (const row of weatherRows) {
    weatherByDay.set(row.metric_date, row.requests_count);
  }

  const apifyByDay = new Map<string, number>();
  for (const row of apifyRows) {
    const day = row.invoked_at.slice(0, 10);
    apifyByDay.set(day, (apifyByDay.get(day) ?? 0) + Math.round(Number(row.spend_usd) * 100));
  }

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
      apify_spend_cents: apifyByDay.get(dateStr) ?? 0,
    });
  }
  return daily;
}

export function aggregateByModel(
  rows: Array<{
    vendor: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_estimate_cents: unknown;
  }>,
): ModelRow[] {
  const modelMap = new Map<string, ModelRow>();
  for (const row of rows) {
    const key = `${row.vendor}:${row.model}`;
    const existing = modelMap.get(key) ?? { vendor: row.vendor, model: row.model, call_count: 0, input_tokens: 0, output_tokens: 0, cost_cents: 0 };
    existing.call_count++;
    existing.input_tokens += row.input_tokens;
    existing.output_tokens += row.output_tokens;
    existing.cost_cents += parseBigIntCol(row.cost_estimate_cents);
    modelMap.set(key, existing);
  }
  return Array.from(modelMap.values()).sort((a, b) => b.cost_cents - a.cost_cents);
}

const STATE_SEVERITY: Record<string, number> = { hard: 3, soft2: 2, soft1: 1, ok: 0 };

export function aggregateApifyByCruiseLine(
  rows: Array<{ cruise_line: string | null; spend_usd: number }>,
): ApifyCruiseLineRow[] {
  const map = new Map<string, ApifyCruiseLineRow>();
  for (const row of rows) {
    const key = row.cruise_line ?? "\0null";
    const existing = map.get(key) ?? { cruise_line: row.cruise_line, run_count: 0, spend_usd: 0 };
    existing.run_count++;
    existing.spend_usd += Number(row.spend_usd);
    map.set(key, existing);
  }
  return Array.from(map.values()).sort((a, b) => b.spend_usd - a.spend_usd);
}

// Sorts tenants: most-severe limit state first; within same state, highest AI
// cost first. The sort order drives the tenant proximity table in the dashboard.
export function sortTenantsByProximity(tenants: TenantRow[]): TenantRow[] {
  return [...tenants].sort((a, b) => {
    const sev = (STATE_SEVERITY[b.ai_cost_limit_state] ?? 0) - (STATE_SEVERITY[a.ai_cost_limit_state] ?? 0);
    if (sev !== 0) return sev;
    return b.ai_cost_cents - a.ai_cost_cents;
  });
}
