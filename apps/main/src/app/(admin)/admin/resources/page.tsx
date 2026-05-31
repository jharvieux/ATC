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

// ── Types ────────────────────────────────────────────────────────────────────

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

interface DashboardData {
  summary: {
    period: string;
    total_ai_cost_cents: number;
    total_email_count: number;
    total_email_cost_cents: number;
    weather_requests_today: number;
    weather_requests_month: number;
    weather_cap: number;
  };
  daily: DailyRow[];
  model_breakdown: ModelRow[];
  tenant_proximity: TenantRow[];
  pricing: {
    ai: Record<string, ModelPricing>;
    resend_rate: number;
  };
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function formatDollars(cents: number): string {
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
  // "2026-05-31" → "5/31"
  const [, m = "1", d = "1"] = iso.split("-");
  return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
}

// ── Stacked area chart ────────────────────────────────────────────────────────

function CostChart({ data, resendRate }: { data: DailyRow[]; resendRate: number }): JSX.Element {
  if (data.length === 0) return <p style={{ color: "#6b7280" }}>No data.</p>;

  const W = 780;
  const H = 200;
  const PAD = { top: 16, right: 16, bottom: 28, left: 56 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const emailCosts = data.map((d) => Math.round(d.email_count * resendRate));
  const totals = data.map((d, i) => d.ai_cost_cents + (emailCosts[i] ?? 0));
  const maxVal = Math.max(...totals, 1);

  const xOf = (i: number) => PAD.left + (i / (data.length - 1)) * chartW;
  const yOf = (val: number) => PAD.top + chartH - (val / maxVal) * chartH;

  // Build SVG path strings for top and bottom of each stacked layer.
  const aiPoints = data.map((d, i) => `${xOf(i).toFixed(1)},${yOf(d.ai_cost_cents).toFixed(1)}`);
  const totalPoints = data.map((d, i) => `${xOf(i).toFixed(1)},${yOf(totals[i] ?? 0).toFixed(1)}`);
  const bottomLine = `${xOf(0).toFixed(1)},${(PAD.top + chartH).toFixed(1)} ${xOf(data.length - 1).toFixed(1)},${(PAD.top + chartH).toFixed(1)}`;

  // AI layer: bottom of chart → ai points → back along bottom
  const aiPath = `M ${xOf(0).toFixed(1)},${(PAD.top + chartH).toFixed(1)} L ${aiPoints.join(" L ")} L ${xOf(data.length - 1).toFixed(1)},${(PAD.top + chartH).toFixed(1)} Z`;
  // Email layer: ai points (forward) → total points (reverse) → close
  const emailPath = `M ${aiPoints.join(" L ")} L ${totalPoints.slice().reverse().join(" L ")} Z`;

  // Y-axis labels (4 ticks)
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    val: maxVal * f,
    y: yOf(maxVal * f),
  }));

  // X-axis labels: show every ~7 days
  const xLabels = data.filter((_, i) => i === 0 || i === data.length - 1 || i % 7 === 0);

  return (
    <div>
      <div style={{ display: "flex", gap: 16, marginBottom: 8, flexWrap: "wrap" }}>
        <Legend color="#3b82f6" label="AI cost (Anthropic + OpenAI)" />
        <Legend color="#10b981" label="Email cost (Resend estimate)" />
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
            <title>{`${d.date}: AI ${formatDollars(d.ai_cost_cents)}, Email ${formatDollars(Math.round(d.email_count * resendRate))}`}</title>
          </rect>
        ))}
        {/* Empty state hint */}
        {totals.every((v) => v === 0) && (
          <text x={W / 2} y={H / 2} fontSize={13} fill="#9ca3af" textAnchor="middle">
            No cost data in this window
          </text>
        )}
      </svg>
      {/* Invisible bottom padding line for the SVG layout */}
      <div style={{ height: bottomLine.length > 0 ? 0 : 0 }} />
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }): JSX.Element {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#6b7280" }}>
      <span style={{ display: "inline-block", width: 12, height: 12, background: color, borderRadius: 2, opacity: 0.8 }} />
      {label}
    </div>
  );
}

// ── Weather chart (bar) ──────────────────────────────────────────────────────

function WeatherChart({ data, cap }: { data: DailyRow[]; cap: number }): JSX.Element {
  const rows = data.filter((d) => d.weather_requests > 0);
  if (rows.length === 0) return <p style={{ color: "#6b7280" }}>No requests recorded.</p>;

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

function StateBadge({ state }: { state: string }): JSX.Element {
  const styles: Record<string, React.CSSProperties> = {
    ok:    { background: "#d1fae5", color: "#065f46" },
    soft1: { background: "#fef3c7", color: "#92400e" },
    soft2: { background: "#ffedd5", color: "#9a3412" },
    hard:  { background: "#fee2e2", color: "#991b1b" },
  };
  return (
    <span style={{ ...(styles[state] ?? styles.ok), padding: "2px 8px", borderRadius: 99, fontSize: 11, fontWeight: 600 }}>
      {state}
    </span>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function ResourceUtilizationPage(): JSX.Element {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pricing editor state
  const [editingPricing, setEditingPricing] = useState(false);
  const [pricingDraft, setPricingDraft] = useState<Record<string, { input: string; output: string }>>({});
  const [resendDraft, setResendDraft] = useState("");
  const [savingPricing, setSavingPricing] = useState(false);
  const [pricingMsg, setPricingMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await adminFetch("/api/admin/resource-utilization");
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const d = (await res.json()) as DashboardData;
      setData(d);
      // Prime pricing editor drafts from loaded data.
      const draft: Record<string, { input: string; output: string }> = {};
      for (const [model, p] of Object.entries(d.pricing.ai)) {
        draft[model] = {
          input: String(p.input_per_million_cents),
          output: String(p.output_per_million_cents),
        };
      }
      setPricingDraft(draft);
      setResendDraft(String(d.pricing.resend_rate));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function savePricing(e: React.FormEvent) {
    e.preventDefault();
    setSavingPricing(true);
    setPricingMsg(null);
    try {
      // Validate + build AI catalog.
      const catalog: Record<string, { input_per_million_cents: number; output_per_million_cents: number }> = {};
      for (const [model, v] of Object.entries(pricingDraft)) {
        const inp = parseInt(v.input, 10);
        const out = parseInt(v.output, 10);
        if (!Number.isInteger(inp) || inp < 0 || !Number.isInteger(out) || out < 0) {
          throw new Error(`Invalid pricing for ${model} — values must be non-negative integers.`);
        }
        catalog[model] = { input_per_million_cents: inp, output_per_million_cents: out };
      }

      const resendRate = parseFloat(resendDraft);
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

      setPricingMsg({ ok: true, text: "Pricing saved." });
      setEditingPricing(false);
      await load();
    } catch (e) {
      setPricingMsg({ ok: false, text: e instanceof Error ? e.message : "Unknown error" });
    } finally {
      setSavingPricing(false);
    }
  }

  if (loading) return <main style={{ padding: 24 }}>Loading…</main>;
  if (!data) return <main style={{ padding: 24, color: "#b91c1c" }}>{error ?? "No data."}</main>;

  const { summary, daily, model_breakdown, tenant_proximity, pricing } = data;
  const totalCostCents = summary.total_ai_cost_cents + summary.total_email_cost_cents;

  return (
    <main style={{ padding: 24, maxWidth: 1000, margin: "0 auto", fontFamily: "sans-serif" }}>
      <h1 style={{ marginBottom: 4 }}>Resource Utilization</h1>
      <p style={{ color: "#6b7280", marginTop: 0 }}>
        Platform-wide costs and usage — current billing period {summary.period}.
      </p>

      {/* ── Summary cards ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginTop: 20 }}>
        <SummaryCard label="Total spend (period)" value={formatDollars(totalCostCents)} sub="AI + email combined" />
        <SummaryCard label="AI spend" value={formatDollars(summary.total_ai_cost_cents)} sub={`${model_breakdown.reduce((s, r) => s + r.call_count, 0).toLocaleString()} calls`} />
        <SummaryCard label="Email spend (est.)" value={formatDollars(summary.total_email_cost_cents)} sub={`${summary.total_email_count.toLocaleString()} sent`} />
        <SummaryCard
          label="Weather today"
          value={`${summary.weather_requests_today.toLocaleString()} / ${summary.weather_cap.toLocaleString()}`}
          sub={`${summary.weather_requests_month.toLocaleString()} this month`}
          alert={summary.weather_requests_today >= summary.weather_cap}
        />
      </div>

      {/* ── Stacked cost chart ── */}
      <section style={card}>
        <h2 style={{ marginTop: 0 }}>30-day cost trend</h2>
        <CostChart data={daily} resendRate={pricing.resend_rate} />
      </section>

      {/* ── AI model breakdown ── */}
      <section style={card}>
        <h2 style={{ marginTop: 0 }}>AI usage by model (last 30 days)</h2>
        {model_breakdown.length === 0 ? (
          <p style={{ color: "#6b7280" }}>No AI calls in this window.</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                {["Vendor", "Model", "Calls", "Input tokens", "Output tokens", "Est. cost"].map((h) => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {model_breakdown.map((r) => (
                <tr key={`${r.vendor}:${r.model}`}>
                  <td style={tdStyle}>{r.vendor}</td>
                  <td style={tdStyle}><code style={{ fontSize: 12 }}>{r.model}</code></td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>{r.call_count.toLocaleString()}</td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>{formatTokens(r.input_tokens)}</td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>{formatTokens(r.output_tokens)}</td>
                  <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatDollars(r.cost_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Weather monitoring ── */}
      <section style={card}>
        <h2 style={{ marginTop: 0 }}>Open-Meteo weather requests</h2>
        <p style={{ color: "#6b7280", marginTop: 0 }}>
          Free tier: {summary.weather_cap.toLocaleString()} req/day.
          Today: <strong>{summary.weather_requests_today.toLocaleString()}</strong>.
          This month: {summary.weather_requests_month.toLocaleString()}.
        </p>
        <WeatherChart data={daily} cap={summary.weather_cap} />
        <p style={{ marginTop: 8, fontSize: 12, color: "#6b7280" }}>
          Adjust the daily cap and see detailed history at{" "}
          <a href="/admin/integrations/weather" style={{ color: "#2563eb" }}>
            /admin/integrations/weather
          </a>
          .
        </p>
      </section>

      {/* ── Tenant proximity ── */}
      <section style={card}>
        <h2 style={{ marginTop: 0 }}>Tenant threshold proximity — current period</h2>
        {tenant_proximity.length === 0 ? (
          <p style={{ color: "#6b7280" }}>No tenant usage recorded this period.</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                {["Tenant", "Slug", "AI spend", "AI limit state", "Emails sent", "Email state"].map((h) => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tenant_proximity.map((t) => (
                <tr key={t.tenant_id}>
                  <td style={tdStyle}>{t.display_name}</td>
                  <td style={tdStyle}><code style={{ fontSize: 12 }}>{t.slug}</code></td>
                  <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{formatDollars(t.ai_cost_cents)}</td>
                  <td style={tdStyle}><StateBadge state={t.ai_cost_limit_state} /></td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>{t.email_sent_count.toLocaleString()}</td>
                  <td style={tdStyle}><StateBadge state={t.email_volume_limit_state} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Pricing catalog ── */}
      <section style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h2 style={{ marginTop: 0 }}>Pricing catalog</h2>
          {!editingPricing && (
            <button onClick={() => setEditingPricing(true)} style={btnSecondary}>Edit</button>
          )}
        </div>

        {pricingMsg && (
          <p style={{ color: pricingMsg.ok ? "#15803d" : "#b91c1c", marginBottom: 12 }}>{pricingMsg.text}</p>
        )}

        {editingPricing ? (
          <form onSubmit={savePricing}>
            <h3 style={{ marginTop: 0, fontSize: 14 }}>AI models (cents per million tokens)</h3>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Model</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Input ¢/M</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Output ¢/M</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(pricingDraft).map(([model, v]) => (
                  <tr key={model}>
                    <td style={tdStyle}><code style={{ fontSize: 12 }}>{model}</code></td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <input
                        type="number"
                        value={v.input}
                        onChange={(e) => setPricingDraft((prev) => ({ ...prev, [model]: { input: e.target.value, output: prev[model]?.output ?? "0" } }))}
                        style={numInput}
                        min={0}
                      />
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <input
                        type="number"
                        value={v.output}
                        onChange={(e) => setPricingDraft((prev) => ({ ...prev, [model]: { input: prev[model]?.input ?? "0", output: e.target.value } }))}
                        style={numInput}
                        min={0}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: 14, color: "#374151" }}>
                Resend cost per email (fractional cents × 100):
                <input
                  type="number"
                  value={resendDraft}
                  onChange={(e) => setResendDraft(e.target.value)}
                  style={{ ...numInput, marginLeft: 12 }}
                  min={0}
                  step={0.1}
                />
              </label>
              <span style={{ marginLeft: 12, fontSize: 12, color: "#6b7280" }}>
                Default 19 = 0.19¢/email (Resend Hobby: $1.90/1k)
              </span>
            </div>

            <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
              <button type="submit" disabled={savingPricing} style={btnPrimary}>
                {savingPricing ? "Saving…" : "Save pricing"}
              </button>
              <button type="button" onClick={() => { setEditingPricing(false); setPricingMsg(null); }} style={btnSecondary}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <h3 style={{ marginTop: 0, fontSize: 14 }}>AI models (cents per million tokens)</h3>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Model</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Input ¢/M</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Output ¢/M</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Input $/M</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Output $/M</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(pricing.ai).map(([model, p]) => (
                  <tr key={model}>
                    <td style={tdStyle}><code style={{ fontSize: 12 }}>{model}</code></td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{p.input_per_million_cents.toLocaleString()}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{p.output_per_million_cents.toLocaleString()}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{(p.input_per_million_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>{(p.output_per_million_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ marginTop: 12, fontSize: 13, color: "#6b7280" }}>
              Resend rate: <strong>{pricing.resend_rate}</strong> ({(pricing.resend_rate / 100).toFixed(4)}¢/email,{" "}
              {formatDollars(pricing.resend_rate * 1000)} per 1k emails)
            </p>
            <p style={{ fontSize: 12, color: "#9ca3af" }}>
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
    <div style={{
      background: "white",
      border: `1px solid ${alert ? "#fca5a5" : "#e5e7eb"}`,
      borderRadius: 8,
      padding: "14px 18px",
      boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
    }}>
      <div style={{ fontSize: 12, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: 4, color: alert ? "#dc2626" : undefined }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: "white",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 20,
  marginTop: 20,
  boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
};

const tableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
  width: "100%",
  fontSize: 13,
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 10px",
  borderBottom: "2px solid #e5e7eb",
  fontSize: 12,
  color: "#6b7280",
  textTransform: "uppercase",
  letterSpacing: 0.4,
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid #f3f4f6",
  verticalAlign: "middle",
};

const btnPrimary: React.CSSProperties = {
  padding: "8px 16px",
  background: "#2563eb",
  color: "white",
  border: "none",
  borderRadius: 6,
  fontWeight: 600,
  cursor: "pointer",
  fontSize: 13,
};

const btnSecondary: React.CSSProperties = {
  padding: "8px 16px",
  background: "white",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontWeight: 500,
  cursor: "pointer",
  fontSize: 13,
};

const numInput: React.CSSProperties = {
  width: 100,
  padding: "4px 8px",
  border: "1px solid #d1d5db",
  borderRadius: 4,
  fontSize: 13,
  textAlign: "right",
};
