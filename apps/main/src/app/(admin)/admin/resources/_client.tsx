"use client";

// Platform resource utilization dashboard.
//
// Shows 30-day cost trends (AI + email, stacked area chart), per-model AI
// breakdown, Open-Meteo weather usage, tenant threshold proximity table,
// and an editable pricing catalog for AI models and Resend per-email rate.
//
// AI model pricing edits go to PUT /api/admin/ai-pricing (existing).
// Resend rate edits go to PUT /api/admin/resource-utilization.

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import type { ModelPricing } from "@/lib/ai/pricing";
import { formatCents } from "@/lib/money";

// ── Types ────────────────────────────────────────────────────────────────────

interface DailyRow {
  date: string;
  ai_cost_cents: number;
  email_count: number;
  weather_requests: number;
  apify_spend_cents: number;
}

interface ApifyLineRow {
  cruise_line: string | null;
  run_count: number;
  spend_usd: number;
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

interface DashboardData {
  summary: {
    period: string;
    total_ai_cost_cents: number;
    total_email_count: number;
    total_email_cost_cents: number;
    weather_requests_today: number;
    weather_requests_month: number;
    weather_cap: number;
    apify_spend_usd_period: number;
    apify_monthly_budget_usd: number;
  };
  daily: DailyRow[];
  model_breakdown: ModelRow[];
  tenant_proximity: TenantRow[];
  apify_by_line: ApifyLineRow[];
  pricing: {
    ai: Record<string, ModelPricing>;
    resend_rate: number;
  };
}

// ── Formatting helpers ───────────────────────────────────────────────────────

// NOT a candidate for lib/money.ts formatCents consolidation — intentionally
// distinct display rules: sub-cent "<$0.01" convention + magnitude-based
// precision (2 decimals for <$100, 0 for ≥$100). Used for cost/spend summaries.
// Always USD (platform-internal cost accounting, no currency param) so the
// #1658 zero-decimal-currency bug formatCents guards against can't occur
// here; reaffirmed on #1779's audit.
function formatDollars(cents: number): string {
  // eslint-disable-next-line atc/no-money-math -- see design-intent comment above (#1779)
  const dollars = cents / 100;
  if (dollars < 0.01 && dollars > 0) return "<$0.01";
  return `$${dollars.toFixed(dollars < 10 ? 2 : dollars < 100 ? 2 : 0)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function shortDate(iso: string): string {
  const [, m = "1", d = "1"] = iso.split("-");
  return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
}

// ── Stacked area chart ────────────────────────────────────────────────────────

function CostChart({ data, resendRate }: { data: DailyRow[]; resendRate: number }): JSX.Element {
  if (data.length === 0) return <p className="text-muted-foreground">No data.</p>;

  const W = 780;
  const H = 200;
  const PAD = { top: 16, right: 16, bottom: 28, left: 56 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const emailCosts = data.map((d) => Math.round(d.email_count * resendRate));
  const emailTotals = data.map((d, i) => d.ai_cost_cents + (emailCosts[i] ?? 0));
  const grandTotals = data.map((d, i) => (emailTotals[i] ?? 0) + d.apify_spend_cents);
  const maxVal = Math.max(...grandTotals, 1);

  const xOf = (i: number) => PAD.left + (i / (data.length - 1)) * chartW;
  const yOf = (val: number) => PAD.top + chartH - (val / maxVal) * chartH;

  const aiPoints = data.map((d, i) => `${xOf(i).toFixed(1)},${yOf(d.ai_cost_cents).toFixed(1)}`);
  const emailTotalPoints = data.map((d, i) => `${xOf(i).toFixed(1)},${yOf(emailTotals[i] ?? 0).toFixed(1)}`);
  const grandTotalPoints = data.map((d, i) => `${xOf(i).toFixed(1)},${yOf(grandTotals[i] ?? 0).toFixed(1)}`);

  // SVG stacking: each layer is a closed polygon. Each layer uses the previous
  // layer's top edge as its base so layers don't overlap.
  const aiPath = `M ${xOf(0).toFixed(1)},${(PAD.top + chartH).toFixed(1)} L ${aiPoints.join(" L ")} L ${xOf(data.length - 1).toFixed(1)},${(PAD.top + chartH).toFixed(1)} Z`;
  const emailPath = `M ${aiPoints.join(" L ")} L ${emailTotalPoints.slice().reverse().join(" L ")} Z`;
  const apifyPath = `M ${emailTotalPoints.join(" L ")} L ${grandTotalPoints.slice().reverse().join(" L ")} Z`;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    val: maxVal * f,
    y: yOf(maxVal * f),
  }));

  // X-axis labels: show every ~7 days
  const xLabels = data.filter((_, i) => i === 0 || i === data.length - 1 || i % 7 === 0);

  return (
    <div>
      <div className="flex gap-4 mb-2 flex-wrap">
        <Legend color="#3b82f6" label="AI cost (Anthropic + OpenAI)" />
        <Legend color="#10b981" label="Email cost (Resend estimate)" />
        <Legend color="#f97316" label="Apify spend" />
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} aria-label="30-day cost chart">
        {/* Grid lines */}
        {yTicks.map((t) => (
          <line key={t.val} x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y} stroke="#f3f4f6" strokeWidth={1} />
        ))}
        {/* Y axis labels */}
        {yTicks.map((t) => (
          <text key={t.val} x={PAD.left - 6} y={t.y + 4} fontSize={10} fill="#9ca3af" textAnchor="end">
            {formatDollars(t.val)}
          </text>
        ))}
        {/* AI area (blue) */}
        <path d={aiPath} fill="#3b82f6" fillOpacity={0.7} />
        {/* Email area (green, stacked on top of AI) */}
        <path d={emailPath} fill="#10b981" fillOpacity={0.7} />
        {/* Apify area (orange, stacked on top of email) */}
        <path d={apifyPath} fill="#f97316" fillOpacity={0.7} />
        {/* Bottom axis */}
        <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + chartH} y2={PAD.top + chartH} stroke="#e5e7eb" />
        {/* X axis labels */}
        {xLabels.map((d) => {
          const idx = data.indexOf(d);
          return (
            <text key={d.date} x={xOf(idx)} y={H - 6} fontSize={10} fill="#9ca3af" textAnchor="middle">
              {shortDate(d.date)}
            </text>
          );
        })}
        {/* Zero line reference for days with no cost */}
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + chartH} stroke="#e5e7eb" />
        {/* Invisible hover rects — tooltip via title */}
        {data.map((d, i) => (
          <rect
            key={d.date}
            x={xOf(i) - 8}
            y={PAD.top}
            width={16}
            height={chartH}
            fill="transparent"
          >
            <title>{`${d.date}: AI ${formatDollars(d.ai_cost_cents)}, Email ${formatDollars(Math.round(d.email_count * resendRate))}, Apify ${formatDollars(d.apify_spend_cents)}`}</title>
          </rect>
        ))}
        {/* Empty state hint */}
        {grandTotals.every((v) => v === 0) && (
          <text x={W / 2} y={H / 2} fontSize={13} fill="#9ca3af" textAnchor="middle">
            No cost data in this window
          </text>
        )}
      </svg>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
      {/* Dynamic chart color — not expressible as static Tailwind */}
      <span className="inline-block w-3 h-3 rounded-sm opacity-80" style={{ background: color }} />
      {label}
    </div>
  );
}

// ── Weather chart (bar) ──────────────────────────────────────────────────────

function WeatherChart({ data, cap }: { data: DailyRow[]; cap: number }): JSX.Element {
  const rows = data.filter((d) => d.weather_requests > 0);
  if (rows.length === 0) return <p className="text-muted-foreground">No requests recorded.</p>;

  const W = 780;
  const H = 140;
  const PAD = 20;
  const barW = Math.max(6, Math.floor((W - PAD * 2) / Math.max(rows.length, 30)));
  const maxVal = Math.max(cap, ...rows.map((d) => d.weather_requests), 1);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} aria-label="30-day weather requests">
      <line x1={PAD} x2={W - PAD} y1={H - (cap / maxVal) * (H - 30) - 10} y2={H - (cap / maxVal) * (H - 30) - 10} stroke="#ef4444" strokeDasharray="4 4" />
      <text x={W - PAD} y={H - (cap / maxVal) * (H - 30) - 14} fontSize={10} fill="#ef4444" textAnchor="end">cap {cap.toLocaleString()}</text>
      {rows.map((d, i) => {
        const barH = (d.weather_requests / maxVal) * (H - 30);
        const overCap = d.weather_requests > cap;
        return (
          <rect key={d.date} x={PAD + i * barW} y={H - barH - 10} width={barW - 2} height={barH} fill={overCap ? "#ef4444" : "#2563eb"}>
            <title>{`${d.date}: ${d.weather_requests.toLocaleString()}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

// ── State badge ──────────────────────────────────────────────────────────────

const STATE_CLASSES: Record<string, string> = {
  ok:    "bg-emerald-100 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-400",
  soft1: "bg-amber-100 dark:bg-amber-950/30 text-amber-800 dark:text-amber-400",
  soft2: "bg-orange-100 dark:bg-orange-950/30 text-orange-800 dark:text-orange-400",
  hard:  "bg-red-100 dark:bg-red-950/30 text-red-800 dark:text-red-400",
};

function StateBadge({ state }: { state: string }): JSX.Element {
  return (
    <span className={`${STATE_CLASSES[state] ?? STATE_CLASSES.ok} px-2 py-0.5 rounded-full text-[11px] font-semibold`}>
      {state}
    </span>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

interface PageState {
  data: DashboardData | null;
  loading: boolean;
  error: string | null;
}

interface PricingFormState {
  editingPricing: boolean;
  pricingDraft: Record<string, { input: string; output: string }>;
  resendDraft: string;
  savingPricing: boolean;
  pricingMsg: { ok: boolean; text: string } | null;
}

interface CapFormState {
  capDraft: string;
  savingCap: boolean;
  capMsg: { ok: boolean; text: string } | null;
}

interface ApifyBudgetFormState {
  apifyBudgetDraft: string;
  savingApifyBudget: boolean;
  apifyBudgetMsg: { ok: boolean; text: string } | null;
}

export default function ResourceUtilizationPage(): JSX.Element {
  // #1812 — the 15 useState hooks (page load, pricing-catalog editor,
  // weather-cap form, Apify-budget form) are grouped into 4 state objects by
  // concern, one useState each, matching the pattern established in #1791.
  const [page, setPage] = useState<PageState>({ data: null, loading: true, error: null });
  const [pricingForm, setPricingForm] = useState<PricingFormState>({
    editingPricing: false, pricingDraft: {}, resendDraft: "", savingPricing: false, pricingMsg: null,
  });
  const [capForm, setCapForm] = useState<CapFormState>({ capDraft: "", savingCap: false, capMsg: null });
  const [apifyBudgetForm, setApifyBudgetForm] = useState<ApifyBudgetFormState>({
    apifyBudgetDraft: "", savingApifyBudget: false, apifyBudgetMsg: null,
  });

  async function load() {
    setPage((p) => ({ ...p, loading: true, error: null }));
    try {
      const res = await adminFetch("/api/admin/resource-utilization");
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const d = (await res.json()) as DashboardData;
      setPage((p) => ({ ...p, data: d }));
      setCapForm((f) => ({ ...f, capDraft: String(d.summary.weather_cap) }));
      setApifyBudgetForm((f) => ({ ...f, apifyBudgetDraft: String(d.summary.apify_monthly_budget_usd) }));
      // Prime pricing editor drafts from loaded data.
      const draft: Record<string, { input: string; output: string }> = {};
      for (const [model, p] of Object.entries(d.pricing.ai)) {
        draft[model] = {
          input: String(p.input_per_million_cents),
          output: String(p.output_per_million_cents),
        };
      }
      setPricingForm((f) => ({ ...f, pricingDraft: draft, resendDraft: String(d.pricing.resend_rate) }));
    } catch (e) {
      setPage((p) => ({ ...p, error: e instanceof Error ? e.message : "Unknown error" }));
    } finally {
      setPage((p) => ({ ...p, loading: false }));
    }
  }

  useEffect(() => { void load(); }, []);

  async function savePricing(e: React.FormEvent) {
    e.preventDefault();
    setPricingForm((f) => ({ ...f, savingPricing: true, pricingMsg: null }));
    try {
      // Validate + build AI catalog.
      const catalog: Record<string, { input_per_million_cents: number; output_per_million_cents: number }> = {};
      for (const [model, v] of Object.entries(pricingForm.pricingDraft)) {
        const inp = parseInt(v.input, 10);
        const out = parseInt(v.output, 10);
        if (!Number.isInteger(inp) || inp < 0 || !Number.isInteger(out) || out < 0) {
          throw new Error(`Invalid pricing for ${model} — values must be non-negative integers.`);
        }
        catalog[model] = { input_per_million_cents: inp, output_per_million_cents: out };
      }

      const resendRate = parseFloat(pricingForm.resendDraft);
      if (!Number.isFinite(resendRate) || resendRate < 0) {
        throw new Error("Resend rate must be a non-negative number.");
      }

      const [aiRes, resendRes] = await Promise.all([
        adminFetch("/api/admin/ai-pricing", { method: "PUT", body: JSON.stringify({ catalog }) }),
        adminFetch("/api/admin/resource-utilization", { method: "PUT", body: JSON.stringify({ resend_cost_per_email_cents: resendRate }) }),
      ]);

      if (!aiRes.ok) {
        const d = (await aiRes.json()) as { error?: string };
        throw new Error(`AI pricing save failed: ${d.error ?? aiRes.status}`);
      }
      if (!resendRes.ok) {
        const d = (await resendRes.json()) as { error?: string };
        throw new Error(`Resend rate save failed: ${d.error ?? resendRes.status}`);
      }

      setPricingForm((f) => ({ ...f, pricingMsg: { ok: true, text: "Pricing saved." }, editingPricing: false }));
      await load();
    } catch (e) {
      setPricingForm((f) => ({ ...f, pricingMsg: { ok: false, text: e instanceof Error ? e.message : "Unknown error" } }));
    } finally {
      setPricingForm((f) => ({ ...f, savingPricing: false }));
    }
  }

  async function saveApifyBudget(e: React.FormEvent) {
    e.preventDefault();
    setApifyBudgetForm((f) => ({ ...f, savingApifyBudget: true, apifyBudgetMsg: null }));
    const v = parseFloat(apifyBudgetForm.apifyBudgetDraft);
    if (!Number.isFinite(v) || v <= 0) {
      setApifyBudgetForm((f) => ({ ...f, apifyBudgetMsg: { ok: false, text: "Budget must be a positive number." }, savingApifyBudget: false }));
      return;
    }
    try {
      const res = await adminFetch("/api/admin/resource-utilization", {
        method: "PUT",
        body: JSON.stringify({ apify_monthly_budget_usd: v }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        throw new Error(d.error ?? "Save failed.");
      }
      setApifyBudgetForm((f) => ({ ...f, apifyBudgetMsg: { ok: true, text: `Budget saved at $${v.toFixed(2)}/month.` } }));
      await load();
    } catch (e) {
      setApifyBudgetForm((f) => ({ ...f, apifyBudgetMsg: { ok: false, text: e instanceof Error ? e.message : "Unknown error" } }));
    } finally {
      setApifyBudgetForm((f) => ({ ...f, savingApifyBudget: false }));
    }
  }

  async function saveCap(e: React.FormEvent) {
    e.preventDefault();
    setCapForm((f) => ({ ...f, savingCap: true, capMsg: null }));
    const cap = parseInt(capForm.capDraft, 10);
    if (!Number.isInteger(cap) || cap < 1 || cap > 10000) {
      setCapForm((f) => ({ ...f, capMsg: { ok: false, text: "Cap must be a whole number between 1 and 10000." }, savingCap: false }));
      return;
    }
    try {
      const res = await adminFetch("/api/admin/integrations/weather", {
        method: "POST",
        body: JSON.stringify({ cap }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string; hint?: string };
        throw new Error(d.hint ?? d.error ?? "Save failed.");
      }
      setCapForm((f) => ({ ...f, capMsg: { ok: true, text: `Daily cap saved at ${cap.toLocaleString()}.` } }));
      await load();
    } catch (e) {
      setCapForm((f) => ({ ...f, capMsg: { ok: false, text: e instanceof Error ? e.message : "Unknown error" } }));
    } finally {
      setCapForm((f) => ({ ...f, savingCap: false }));
    }
  }

  if (page.loading) return <main className="px-6 py-6">Loading…</main>;
  if (!page.data) return <main className="px-6 py-6 text-red-700 dark:text-red-400">{page.error ?? "No data."}</main>;

  const { data } = page;
  const { editingPricing, pricingDraft, resendDraft, savingPricing, pricingMsg } = pricingForm;
  const { capDraft, savingCap, capMsg } = capForm;
  const { apifyBudgetDraft, savingApifyBudget, apifyBudgetMsg } = apifyBudgetForm;
  const { summary, daily, model_breakdown, tenant_proximity, apify_by_line, pricing } = data;
  const totalCostCents = summary.total_ai_cost_cents + summary.total_email_cost_cents;

  const cardCls = "bg-card border border-border rounded-lg p-5 mt-5 shadow-sm";
  const thCls = "text-left px-2.5 py-1.5 border-b-2 border-border text-[12px] text-muted-foreground uppercase tracking-[0.4px] whitespace-nowrap";
  const tdCls = "px-2.5 py-2 border-b border-muted align-middle text-sm";

  return (
    <main className="px-6 py-6 max-w-[1000px] mx-auto">
      <h1 className="mb-1">Resource Utilization</h1>
      <p className="text-muted-foreground mt-0">
        Platform-wide costs and usage — current billing period {summary.period}.
      </p>

      {/* ── Summary cards ── */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-4 mt-5">
        <SummaryCard label="Total spend (period)" value={formatDollars(totalCostCents)} sub="AI + email combined" />
        <SummaryCard label="AI spend" value={formatDollars(summary.total_ai_cost_cents)} sub={`${model_breakdown.reduce((s, r) => s + r.call_count, 0).toLocaleString()} calls`} />
        <SummaryCard label="Email spend (est.)" value={formatDollars(summary.total_email_cost_cents)} sub={`${summary.total_email_count.toLocaleString()} sent`} />
        <SummaryCard
          label="Weather today"
          value={`${summary.weather_requests_today.toLocaleString()} / ${summary.weather_cap.toLocaleString()}`}
          sub={`${summary.weather_requests_month.toLocaleString()} this month`}
          alert={summary.weather_requests_today >= summary.weather_cap}
        />
        <SummaryCard
          label="Apify spend (period)"
          value={`$${summary.apify_spend_usd_period.toFixed(2)}`}
          sub={`Budget: $${summary.apify_monthly_budget_usd.toFixed(0)}/month`}
          alert={summary.apify_spend_usd_period >= summary.apify_monthly_budget_usd * 0.9}
        />
      </div>

      {/* ── Stacked cost chart ── */}
      <section className={cardCls}>
        <h2 className="mt-0">30-day cost trend</h2>
        <CostChart data={daily} resendRate={pricing.resend_rate} />
      </section>

      {/* ── AI model breakdown ── */}
      <section className={cardCls}>
        <h2 className="mt-0">AI usage by model (last 30 days)</h2>
        {model_breakdown.length === 0 ? (
          <p className="text-muted-foreground">No AI calls in this window.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {["Vendor", "Model", "Calls", "Input tokens", "Output tokens", "Est. cost"].map((h) => (
                  <th key={h} className={thCls}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {model_breakdown.map((r) => (
                <tr key={`${r.vendor}:${r.model}`}>
                  <td className={tdCls}>{r.vendor}</td>
                  <td className={tdCls}><code className="text-[12px]">{r.model}</code></td>
                  <td className={`${tdCls} text-right`}>{r.call_count.toLocaleString()}</td>
                  <td className={`${tdCls} text-right`}>{formatTokens(r.input_tokens)}</td>
                  <td className={`${tdCls} text-right`}>{formatTokens(r.output_tokens)}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{formatDollars(r.cost_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Weather monitoring ── */}
      <section className={cardCls}>
        <h2 className="mt-0">Open-Meteo weather requests</h2>
        <p className="text-muted-foreground mt-0">
          Free tier cap: {summary.weather_cap.toLocaleString()} req/day.
          Today: <strong>{summary.weather_requests_today.toLocaleString()}</strong>.
          This month: {summary.weather_requests_month.toLocaleString()}.
        </p>
        <WeatherChart data={daily} cap={summary.weather_cap} />
        <div className="mt-4">
          <form onSubmit={saveCap} className="flex gap-3 items-center flex-wrap">
            <label className="text-[13px] text-foreground">
              Adjust daily cap:
              <input
                type="number"
                value={capDraft}
                onChange={(e) => setCapForm((f) => ({ ...f, capDraft: e.target.value }))}
                min={1}
                max={10000}
                className="ml-2.5 w-[90px] px-2 py-1 border border-border rounded text-right text-[13px]"
                disabled={savingCap}
              />
            </label>
            <button
              type="submit"
              disabled={savingCap}
              className="px-4 py-2 bg-card border border-border rounded-md text-sm font-medium disabled:opacity-50"
            >
              {savingCap ? "Saving…" : "Save cap"}
            </button>
          </form>
          {capMsg && (
            <p className={`mt-2 text-[13px] ${capMsg.ok ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>{capMsg.text}</p>
          )}
        </div>
      </section>

      {/* ── Apify pricing data ── */}
      <section className={cardCls}>
        <h2 className="mt-0">Apify pricing data (last 30 days)</h2>
        <p className="text-muted-foreground mt-0">
          Month-to-date: <strong>${summary.apify_spend_usd_period.toFixed(2)}</strong>.{" "}
          Budget cap: <strong>${summary.apify_monthly_budget_usd.toFixed(0)}/month</strong>.
        </p>
        {apify_by_line.length === 0 ? (
          <p className="text-muted-foreground">No Apify runs in this window.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {["Cruise line", "Runs", "Spend (USD)"].map((h) => (
                  <th key={h} className={thCls}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {apify_by_line.map((r) => (
                <tr key={r.cruise_line ?? "(none)"}>
                  <td className={tdCls}>{r.cruise_line ?? <em>none</em>}</td>
                  <td className={`${tdCls} text-right`}>{r.run_count.toLocaleString()}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>${r.spend_usd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-4">
          <form onSubmit={saveApifyBudget} className="flex gap-3 items-center flex-wrap">
            <label className="text-[13px] text-foreground">
              Monthly budget cap (USD):
              <input
                type="number"
                value={apifyBudgetDraft}
                onChange={(e) => setApifyBudgetForm((f) => ({ ...f, apifyBudgetDraft: e.target.value }))}
                min={1}
                step={1}
                className="ml-2.5 w-[90px] px-2 py-1 border border-border rounded text-right text-[13px]"
                disabled={savingApifyBudget}
              />
            </label>
            <button
              type="submit"
              disabled={savingApifyBudget}
              className="px-4 py-2 bg-card border border-border rounded-md text-sm font-medium disabled:opacity-50"
            >
              {savingApifyBudget ? "Saving…" : "Save budget"}
            </button>
          </form>
          {apifyBudgetMsg && (
            <p className={`mt-2 text-[13px] ${apifyBudgetMsg.ok ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>{apifyBudgetMsg.text}</p>
          )}
        </div>
      </section>

      {/* ── Tenant proximity ── */}
      <section className={cardCls}>
        <h2 className="mt-0">Tenant threshold proximity — current period</h2>
        {tenant_proximity.length === 0 ? (
          <p className="text-muted-foreground">No tenant usage recorded this period.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {["Tenant", "Slug", "AI spend", "AI limit state", "Emails sent", "Email state"].map((h) => (
                  <th key={h} className={thCls}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tenant_proximity.map((t) => (
                <tr key={t.tenant_id}>
                  <td className={tdCls}>{t.display_name}</td>
                  <td className={tdCls}><code className="text-[12px]">{t.slug}</code></td>
                  <td className={`${tdCls} text-right tabular-nums`}>{formatDollars(t.ai_cost_cents)}</td>
                  <td className={tdCls}><StateBadge state={t.ai_cost_limit_state} /></td>
                  <td className={`${tdCls} text-right`}>{t.email_sent_count.toLocaleString()}</td>
                  <td className={tdCls}><StateBadge state={t.email_volume_limit_state} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Pricing catalog ── */}
      <section className={cardCls}>
        <div className="flex justify-between items-baseline">
          <h2 className="mt-0">Pricing catalog</h2>
          {!editingPricing && (
            <button
              onClick={() => setPricingForm((f) => ({ ...f, editingPricing: true }))}
              className="px-4 py-2 bg-card border border-border rounded-md text-sm font-medium"
            >
              Edit
            </button>
          )}
        </div>

        {pricingMsg && (
          <p className={`mb-3 ${pricingMsg.ok ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>{pricingMsg.text}</p>
        )}

        {editingPricing ? (
          <form onSubmit={savePricing}>
            <h3 className="mt-0 text-[14px]">AI models (cents per million tokens)</h3>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={thCls}>Model</th>
                  <th className={`${thCls} text-right`}>Input ¢/M</th>
                  <th className={`${thCls} text-right`}>Output ¢/M</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(pricingDraft).map(([model, v]) => (
                  <tr key={model}>
                    <td className={tdCls}><code className="text-[12px]">{model}</code></td>
                    <td className={`${tdCls} text-right`}>
                      <input
                        type="number"
                        value={v.input}
                        onChange={(e) => setPricingForm((f) => ({ ...f, pricingDraft: { ...f.pricingDraft, [model]: { input: e.target.value, output: f.pricingDraft[model]?.output ?? "0" } } }))}
                        className="w-[100px] px-2 py-1 border border-border rounded text-right text-[13px]"
                        min={0}
                      />
                    </td>
                    <td className={`${tdCls} text-right`}>
                      <input
                        type="number"
                        value={v.output}
                        onChange={(e) => setPricingForm((f) => ({ ...f, pricingDraft: { ...f.pricingDraft, [model]: { input: f.pricingDraft[model]?.input ?? "0", output: e.target.value } } }))}
                        className="w-[100px] px-2 py-1 border border-border rounded text-right text-[13px]"
                        min={0}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-4">
              <label className="text-[14px] text-foreground">
                Resend cost per email (fractional cents × 100):
                <input
                  type="number"
                  value={resendDraft}
                  onChange={(e) => setPricingForm((f) => ({ ...f, resendDraft: e.target.value }))}
                  className="ml-3 w-[100px] px-2 py-1 border border-border rounded text-right text-[13px]"
                  min={0}
                  step={0.1}
                />
              </label>
              <span className="ml-3 text-[12px] text-muted-foreground">
                Default 19 = 0.19¢/email (Resend Hobby: $1.90/1k)
              </span>
            </div>

            <div className="flex gap-3 mt-4">
              <button
                type="submit"
                disabled={savingPricing}
                className="px-4 py-2 bg-blue-600 text-white border-none rounded-md font-semibold text-[13px] disabled:opacity-50"
              >
                {savingPricing ? "Saving…" : "Save pricing"}
              </button>
              <button
                type="button"
                onClick={() => setPricingForm((f) => ({ ...f, editingPricing: false, pricingMsg: null }))}
                className="px-4 py-2 bg-card border border-border rounded-md text-sm font-medium"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <h3 className="mt-0 text-[14px]">AI models (cents per million tokens)</h3>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <th className={thCls}>Model</th>
                  <th className={`${thCls} text-right`}>Input ¢/M</th>
                  <th className={`${thCls} text-right`}>Output ¢/M</th>
                  <th className={`${thCls} text-right`}>Input $/M</th>
                  <th className={`${thCls} text-right`}>Output $/M</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(pricing.ai).map(([model, p]) => (
                  <tr key={model}>
                    <td className={tdCls}><code className="text-[12px]">{model}</code></td>
                    <td className={`${tdCls} text-right`}>{p.input_per_million_cents.toLocaleString()}</td>
                    <td className={`${tdCls} text-right`}>{p.output_per_million_cents.toLocaleString()}</td>
                    <td className={`${tdCls} text-right`}>{formatCents(p.input_per_million_cents)}</td>
                    <td className={`${tdCls} text-right`}>{formatCents(p.output_per_million_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[13px] text-muted-foreground">
              Resend rate: <strong>{pricing.resend_rate}</strong> ({(pricing.resend_rate / 100).toFixed(4)}¢/email,{" "}
              {formatDollars(pricing.resend_rate * 1000)} per 1k emails)
            </p>
            <p className="text-[12px] text-muted-foreground">
              Pricing is used for cost estimates only. Actual vendor invoices are the source of truth. Update when vendor rates change.
            </p>
          </>
        )}
      </section>
    </main>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, alert }: { label: string; value: string; sub?: string; alert?: boolean }): JSX.Element {
  return (
    <div className={`bg-card border rounded-lg px-[18px] py-[14px] shadow-sm ${alert ? "border-red-300 dark:border-red-700" : "border-border"}`}>
      <div className="text-[12px] text-muted-foreground uppercase tracking-[0.5px]">{label}</div>
      <div className={`text-[26px] font-bold mt-1 ${alert ? "text-red-600 dark:text-red-400" : "text-foreground"}`}>{value}</div>
      {sub && <div className="text-[12px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}
