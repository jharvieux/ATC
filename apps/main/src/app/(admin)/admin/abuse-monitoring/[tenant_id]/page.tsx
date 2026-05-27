"use client";

// §27 — Per-tenant abuse drilldown for platform admin.
//
// One screen — metric history (6 most recent periods), RAG row,
// active + historical overrides, recent state transitions, recent
// tenant-initiated requests. Also a small inline form to create a
// new override for this tenant directly.

import Link from "next/link";
import { useState, useEffect } from "react";
import { use } from "react";
import { adminFetch } from "@/lib/admin-fetch";

type Detail = {
  tenant_id: string;
  metrics_history: Array<Record<string, unknown>>;
  rag: Record<string, unknown> | null;
  overrides: Array<Record<string, unknown> & { id: string }>;
  active_overrides: Array<Record<string, unknown> & { id: string }>;
  recent_events: Array<Record<string, unknown> & { id: string }>;
  recent_requests: Array<Record<string, unknown> & { id: string }>;
};

const DIMENSIONS = ["ai_cost", "rag_cap", "chat_volume", "email_volume", "group_invite"] as const;
const TIER_OVERRIDES = ["soft1", "soft2", "hard", "base_cap"] as const;

const pageStyle: React.CSSProperties = { padding: 24, maxWidth: 1200, margin: "0 auto" };
const tableStyle: React.CSSProperties = { width: "100%", borderCollapse: "collapse", marginTop: 8 };
const thStyle: React.CSSProperties = { textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb", background: "#f3f4f6" };
const tdStyle: React.CSSProperties = { padding: 8, borderBottom: "1px solid #f3f4f6" };

export default function TenantDetailPage(props: { params: Promise<{ tenant_id: string }> }): JSX.Element {
  const { tenant_id } = use(props.params);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Override form state.
  const [dimension, setDimension] = useState<typeof DIMENSIONS[number]>("ai_cost");
  const [tier_override, setTierOverride] = useState<typeof TIER_OVERRIDES[number]>("hard");
  const [threshold_value, setThresholdValue] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    adminFetch(`/api/admin/abuse/tenant/${tenant_id}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) setError(j.error);
        else setDetail(j.detail);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [tenant_id]);

  async function createOverride() {
    if (!Number.isFinite(Number(threshold_value)) || Number(threshold_value) < 0 || reason.length < 5) {
      alert("threshold_value must be a non-negative number and reason ≥ 5 chars");
      return;
    }
    setSubmitting(true);
    const res = await adminFetch("/api/admin/abuse/overrides", {
      method: "POST",
      body: JSON.stringify({
        tenant_id,
        dimension,
        tier_override,
        threshold_value: Number(threshold_value),
        reason,
      }),
    });
    const json = await res.json();
    setSubmitting(false);
    if (!json.ok) alert(json.error ?? "create failed");
    else window.location.reload();
  }

  if (loading) return <main style={pageStyle}><p>Loading…</p></main>;
  if (error) return <main style={pageStyle}><p style={{ color: "#dc2626" }}>{error}</p></main>;
  if (!detail) return <main style={pageStyle}><p>No data.</p></main>;

  return (
    <main style={pageStyle}>
      <Link href="/admin/abuse-monitoring" style={{ color: "#3b82f6" }}>← Back</Link>
      <h1>Tenant {tenant_id}</h1>

      <h2 style={{ marginTop: 24 }}>Create override</h2>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select value={dimension} onChange={(e) => setDimension(e.target.value as typeof DIMENSIONS[number])}>
          {DIMENSIONS.map((d) => <option key={d}>{d}</option>)}
        </select>
        <select value={tier_override} onChange={(e) => setTierOverride(e.target.value as typeof TIER_OVERRIDES[number])}>
          {TIER_OVERRIDES.map((t) => <option key={t}>{t}</option>)}
        </select>
        <input
          type="number" min="0" placeholder="threshold_value"
          value={threshold_value} onChange={(e) => setThresholdValue(e.target.value)}
          style={{ padding: 4, width: 140 }}
        />
        <input
          placeholder="reason (≥5 chars)" value={reason} onChange={(e) => setReason(e.target.value)}
          style={{ padding: 4, width: 280 }}
        />
        <button disabled={submitting} onClick={createOverride}>Create override</button>
      </div>

      <h2 style={{ marginTop: 24 }}>Metric history (last 6 periods)</h2>
      <table style={tableStyle}>
        <thead><tr>
          <th style={thStyle}>Period</th>
          <th style={thStyle}>AI ¢</th><th style={thStyle}>Chat #</th><th style={thStyle}>Email #</th><th style={thStyle}>Invites #</th>
          <th style={thStyle}>AI state</th><th style={thStyle}>Chat state</th><th style={thStyle}>Email state</th><th style={thStyle}>Invite state</th>
        </tr></thead>
        <tbody>
          {detail.metrics_history.map((m, i) => (
            <tr key={i}>
              <td style={tdStyle}>{String(m.billing_period ?? "")}</td>
              <td style={tdStyle}>{String(m.ai_cost_cents ?? "")}</td>
              <td style={tdStyle}>{String(m.chat_messages_count ?? "")}</td>
              <td style={tdStyle}>{String(m.email_sent_count ?? "")}</td>
              <td style={tdStyle}>{String(m.group_invitees_count ?? "")}</td>
              <td style={tdStyle}>{String(m.ai_cost_limit_state ?? "")}</td>
              <td style={tdStyle}>{String(m.chat_volume_limit_state ?? "")}</td>
              <td style={tdStyle}>{String(m.email_volume_limit_state ?? "")}</td>
              <td style={tdStyle}>{String(m.group_invite_limit_state ?? "")}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: 24 }}>RAG quota</h2>
      {detail.rag ? (
        <pre style={{ background: "#f9fafb", padding: 10, borderRadius: 4 }}>{JSON.stringify(detail.rag, null, 2)}</pre>
      ) : <p>No RAG quota row.</p>}

      <h2 style={{ marginTop: 24 }}>Active overrides ({detail.active_overrides.length})</h2>
      <pre style={{ background: "#f9fafb", padding: 10, borderRadius: 4 }}>{JSON.stringify(detail.active_overrides, null, 2)}</pre>

      <h2 style={{ marginTop: 24 }}>Recent state events</h2>
      <pre style={{ background: "#f9fafb", padding: 10, borderRadius: 4 }}>{JSON.stringify(detail.recent_events, null, 2)}</pre>

      <h2 style={{ marginTop: 24 }}>Tenant requests</h2>
      <pre style={{ background: "#f9fafb", padding: 10, borderRadius: 4 }}>{JSON.stringify(detail.recent_requests, null, 2)}</pre>
    </main>
  );
}
