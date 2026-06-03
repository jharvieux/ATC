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

const thCls = "text-left px-2 py-2 border-b border-border bg-muted font-semibold text-sm";
const tdCls = "px-2 py-2 border-b border-muted text-sm";

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

  if (loading) return <main className="px-6 py-6 max-w-[1200px] mx-auto"><p>Loading…</p></main>;
  if (error) return <main className="px-6 py-6 max-w-[1200px] mx-auto"><p className="text-red-600 dark:text-red-400">{error}</p></main>;
  if (!detail) return <main className="px-6 py-6 max-w-[1200px] mx-auto"><p>No data.</p></main>;

  return (
    <main className="px-6 py-6 max-w-[1200px] mx-auto">
      <Link href="/admin/abuse-monitoring" className="text-primary">← Back</Link>
      <h1>Tenant {tenant_id}</h1>

      <h2 className="mt-6">Create override</h2>
      <div className="flex gap-2 items-center flex-wrap">
        <select
          value={dimension}
          onChange={(e) => setDimension(e.target.value as typeof DIMENSIONS[number])}
          className="px-2 py-1.5 border border-border rounded text-sm"
        >
          {DIMENSIONS.map((d) => <option key={d}>{d}</option>)}
        </select>
        <select
          value={tier_override}
          onChange={(e) => setTierOverride(e.target.value as typeof TIER_OVERRIDES[number])}
          className="px-2 py-1.5 border border-border rounded text-sm"
        >
          {TIER_OVERRIDES.map((t) => <option key={t}>{t}</option>)}
        </select>
        <input
          type="number"
          min="0"
          placeholder="threshold_value"
          value={threshold_value}
          onChange={(e) => setThresholdValue(e.target.value)}
          className="px-2 py-1.5 border border-border rounded text-sm w-[140px]"
        />
        <input
          placeholder="reason (≥5 chars)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="px-2 py-1.5 border border-border rounded text-sm w-[280px]"
        />
        <button
          disabled={submitting}
          onClick={createOverride}
          className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm font-semibold disabled:opacity-50"
        >
          Create override
        </button>
      </div>

      <h2 className="mt-6">Metric history (last 6 periods)</h2>
      <table className="w-full border-collapse mt-2">
        <thead><tr>
          <th className={thCls}>Period</th>
          <th className={thCls}>AI ¢</th><th className={thCls}>Chat #</th><th className={thCls}>Email #</th><th className={thCls}>Invites #</th>
          <th className={thCls}>AI state</th><th className={thCls}>Chat state</th><th className={thCls}>Email state</th><th className={thCls}>Invite state</th>
        </tr></thead>
        <tbody>
          {detail.metrics_history.map((m, i) => (
            <tr key={i}>
              <td className={tdCls}>{String(m.billing_period ?? "")}</td>
              <td className={tdCls}>{String(m.ai_cost_cents ?? "")}</td>
              <td className={tdCls}>{String(m.chat_messages_count ?? "")}</td>
              <td className={tdCls}>{String(m.email_sent_count ?? "")}</td>
              <td className={tdCls}>{String(m.group_invitees_count ?? "")}</td>
              <td className={tdCls}>{String(m.ai_cost_limit_state ?? "")}</td>
              <td className={tdCls}>{String(m.chat_volume_limit_state ?? "")}</td>
              <td className={tdCls}>{String(m.email_volume_limit_state ?? "")}</td>
              <td className={tdCls}>{String(m.group_invite_limit_state ?? "")}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="mt-6">RAG quota</h2>
      {detail.rag ? (
        <pre className="bg-muted p-2.5 rounded text-[13px] font-mono overflow-auto">{JSON.stringify(detail.rag, null, 2)}</pre>
      ) : <p>No RAG quota row.</p>}

      <h2 className="mt-6">Active overrides ({detail.active_overrides.length})</h2>
      <pre className="bg-muted p-2.5 rounded text-[13px] font-mono overflow-auto">{JSON.stringify(detail.active_overrides, null, 2)}</pre>

      <h2 className="mt-6">Recent state events</h2>
      <pre className="bg-muted p-2.5 rounded text-[13px] font-mono overflow-auto">{JSON.stringify(detail.recent_events, null, 2)}</pre>

      <h2 className="mt-6">Tenant requests</h2>
      <pre className="bg-muted p-2.5 rounded text-[13px] font-mono overflow-auto">{JSON.stringify(detail.recent_requests, null, 2)}</pre>
    </main>
  );
}
