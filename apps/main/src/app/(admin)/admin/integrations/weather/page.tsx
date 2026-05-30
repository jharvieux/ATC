"use client";

// §23.4 — Weather integration admin page.
//
// Shows current Open-Meteo usage so the operator can see when to upgrade
// off the free tier, plus an editable daily cap that the helper reads
// before each fetch. The chart is a simple bar SVG (no chart library
// dependency — 30 bars is tractable to render by hand).

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";

interface UsageRow {
  metric_date: string;
  requests_count: number;
  last_request_at: string | null;
}

interface UsageView {
  cap: number;
  cap_ceiling: number;
  requests_today: number;
  requests_this_month: number;
  daily_history: UsageRow[];
  avg_7d: number;
}

export default function WeatherUsagePage() {
  const [view, setView] = useState<UsageView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [capInput, setCapInput] = useState("");

  async function load() {
    try {
      const res = await adminFetch("/api/admin/integrations/weather");
      if (!res.ok) throw new Error(`Read failed (${res.status}).`);
      const data = (await res.json()) as UsageView;
      setView(data);
      setCapInput(String(data.cap));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function saveCap(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    const parsed = Number(capInput);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > (view?.cap_ceiling ?? 10000)) {
      setError(`Cap must be a whole number between 1 and ${view?.cap_ceiling ?? 10000}.`);
      setSaving(false);
      return;
    }
    try {
      const res = await adminFetch("/api/admin/integrations/weather", {
        method: "POST",
        body: JSON.stringify({ cap: parsed }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string; hint?: string };
        throw new Error(data.hint ?? data.error ?? "Save failed.");
      }
      setSuccessMsg(`Cap saved at ${parsed}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <main style={{ padding: 24 }}>Loading…</main>;
  if (!view) return <main style={{ padding: 24, color: "#b91c1c" }}>{error ?? "No data."}</main>;

  const upgradeHint = renderUpgradeHint(view);

  return (
    <main style={{ padding: 24, maxWidth: 960, margin: "0 auto" }}>
      <h1>Weather integration — Open-Meteo</h1>
      <p style={{ color: "#555" }}>
        Open-Meteo serves up to {view.cap_ceiling.toLocaleString()} requests/day on the free tier.
        The helper reads this cap before each fetch and skips the email weather section once it&rsquo;s exceeded.
      </p>

      <section style={cardStyle}>
        <h2 style={{ marginTop: 0 }}>Current usage</h2>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <Stat label="Today" value={view.requests_today.toLocaleString()} />
          <Stat label="This month" value={view.requests_this_month.toLocaleString()} />
          <Stat label="7-day avg" value={view.avg_7d.toLocaleString()} />
          <Stat label="Daily cap" value={view.cap.toLocaleString()} />
        </div>
        <p style={{ marginTop: 16, color: "#444" }}>{upgradeHint}</p>
      </section>

      <section style={cardStyle}>
        <h2 style={{ marginTop: 0 }}>30-day history</h2>
        <UsageChart history={view.daily_history} cap={view.cap} />
      </section>

      <section style={cardStyle}>
        <h2 style={{ marginTop: 0 }}>Adjust daily cap</h2>
        <form onSubmit={saveCap} style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <input
            type="number"
            value={capInput}
            onChange={(e) => setCapInput(e.target.value)}
            min={1}
            max={view.cap_ceiling}
            style={{ padding: 8, fontSize: 16, width: 120, border: "1px solid #d1d5db", borderRadius: 6 }}
            disabled={saving}
          />
          <button
            type="submit"
            disabled={saving}
            style={{
              padding: "8px 16px",
              background: "#2563eb",
              color: "white",
              border: "none",
              borderRadius: 6,
              fontWeight: 600,
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </form>
        {error && (
          <p style={{ color: "#b91c1c", marginTop: 12 }}>{error}</p>
        )}
        {successMsg && (
          <p style={{ color: "#15803d", marginTop: 12 }}>{successMsg}</p>
        )}
      </section>
    </main>
  );
}

function renderUpgradeHint(v: UsageView): string {
  if (v.avg_7d <= 0) {
    return "No 7-day usage history yet — projections will appear once the helper has run for a few days.";
  }
  if (v.avg_7d >= v.cap) {
    return `7-day average (${v.avg_7d.toLocaleString()}) is at or over the cap. Consider raising the cap or upgrading to a paid plan.`;
  }
  const headroom = v.cap - v.avg_7d;
  const ratio = (v.avg_7d / v.cap) * 100;
  return `At the current 7-day rate of ${v.avg_7d.toLocaleString()}/day (${ratio.toFixed(0)}% of cap), you have ${headroom.toLocaleString()} req/day of headroom.`;
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ minWidth: 140 }}>
      <div style={{ color: "#6b7280", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function UsageChart({ history, cap }: { history: UsageRow[]; cap: number }): JSX.Element {
  if (history.length === 0) {
    return <p style={{ color: "#6b7280" }}>No usage recorded in the last 30 days.</p>;
  }

  const width = 720;
  const height = 200;
  const barWidth = Math.max(8, Math.floor((width - 40) / Math.max(history.length, 30)));
  const max = Math.max(cap, ...history.map((r) => r.requests_count), 1);

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} aria-label="30-day weather requests">
      {/* Cap reference line */}
      <line
        x1={20}
        x2={width - 20}
        y1={height - (cap / max) * (height - 30) - 10}
        y2={height - (cap / max) * (height - 30) - 10}
        stroke="#ef4444"
        strokeDasharray="4 4"
      />
      <text
        x={width - 20}
        y={height - (cap / max) * (height - 30) - 14}
        fontSize={11}
        fill="#ef4444"
        textAnchor="end"
      >
        cap {cap.toLocaleString()}
      </text>
      {history.map((row, i) => {
        const barHeight = (row.requests_count / max) * (height - 30);
        const x = 20 + i * barWidth;
        const y = height - barHeight - 10;
        const overCap = row.requests_count > cap;
        return (
          <rect
            key={row.metric_date}
            x={x}
            y={y}
            width={barWidth - 2}
            height={barHeight}
            fill={overCap ? "#ef4444" : "#2563eb"}
          >
            <title>{`${row.metric_date}: ${row.requests_count.toLocaleString()}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

const cardStyle: React.CSSProperties = {
  background: "white",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 20,
  marginTop: 20,
  boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
};
