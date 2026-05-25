"use client";

// §27 — Platform admin abuse-monitoring dashboard.
//
// Tabs:
//   1. Overview            — counts + recent state transitions
//   2. Tenants at risk     — by dimension, current state, current value
//   3. Override queue      — tenant-initiated requests (approve / deny)
//   4. Active overrides    — admin can revoke
//   5. Drift log           — nightly recompute corrections

import { useState, useEffect } from "react";
import Link from "next/link";
import { adminFetch } from "@/lib/admin-fetch";

type Summary = {
  tenants_at_risk: Array<Record<string, unknown> & { tenant_id: string }>;
  rag_at_risk: Array<Record<string, unknown> & { tenant_id: string }>;
  pending_requests_count: number;
  active_overrides: Array<Record<string, unknown> & { id: string; tenant_id: string; dimension: string; threshold_value: string; effective_to: string | null }>;
  recent_drift: Array<{ id: string; tenant_id: string; dimension: string; drift_amount: string; detected_at: string }>;
  recent_transitions: Array<{ id: string; tenant_id: string; dimension: string; from_state: string; to_state: string; metric_value: string; threshold_crossed: string; triggered_at: string }>;
};

type OverrideRequest = {
  id: string;
  tenant_id: string;
  dimension: string;
  requested_threshold_kind: string | null;
  current_state: string;
  reason: string;
  requested_at: string;
  requested_by_user_id: string;
};

const TABS = ["overview", "at_risk", "requests", "active_overrides", "drift_log"] as const;
type Tab = typeof TABS[number];

const TAB_LABEL: Record<Tab, string> = {
  overview: "Overview",
  at_risk: "Tenants at risk",
  requests: "Override queue",
  active_overrides: "Active overrides",
  drift_log: "Drift log",
};

export default function AbuseMonitoringPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>("overview");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [requests, setRequests] = useState<OverrideRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      adminFetch("/api/admin/abuse/summary").then((r) => r.json()),
      adminFetch("/api/admin/abuse/override-requests?status=pending").then((r) => r.json()),
    ])
      .then(([s, q]) => {
        if (s.error) setError(s.error);
        else setSummary(s.summary);
        if (!q.error) setRequests(q.items);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <main style={pageStyle}><p>Loading…</p></main>;
  if (error) return <main style={pageStyle}><p style={{ color: "#dc2626" }}>{error}</p></main>;
  if (!summary) return <main style={pageStyle}><p>No data.</p></main>;

  return (
    <main style={pageStyle}>
      <h1>Abuse monitoring</h1>
      <p style={{ color: "#555" }}>§27 — SaaS abuse / cost-control dashboard. Updated on each page load.</p>

      <nav style={{ display: "flex", gap: 12, marginTop: 16, borderBottom: "1px solid #e5e7eb" }}>
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "8px 12px",
              border: "none",
              background: "transparent",
              borderBottom: tab === t ? "2px solid #3b82f6" : "2px solid transparent",
              fontWeight: tab === t ? 600 : 400,
              cursor: "pointer",
            }}
          >
            {TAB_LABEL[t]}
            {t === "requests" && summary.pending_requests_count > 0 && (
              <span style={{ marginLeft: 6, background: "#dc2626", color: "white", borderRadius: 10, padding: "1px 8px", fontSize: 12 }}>
                {summary.pending_requests_count}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div style={{ marginTop: 20 }}>
        {tab === "overview" && <OverviewTab summary={summary} />}
        {tab === "at_risk" && <AtRiskTab summary={summary} />}
        {tab === "requests" && <RequestsTab requests={requests} />}
        {tab === "active_overrides" && <OverridesTab summary={summary} />}
        {tab === "drift_log" && <DriftTab summary={summary} />}
      </div>
    </main>
  );
}

const pageStyle: React.CSSProperties = { padding: 24, maxWidth: 1200, margin: "0 auto" };
const tableStyle: React.CSSProperties = { width: "100%", borderCollapse: "collapse", marginTop: 16 };
const thStyle: React.CSSProperties = { textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb", background: "#f3f4f6" };
const tdStyle: React.CSSProperties = { padding: 10, borderBottom: "1px solid #f3f4f6" };

function OverviewTab({ summary }: { summary: Summary }): JSX.Element {
  return (
    <section>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <Stat label="Tenants at risk (monthly)" value={summary.tenants_at_risk.length} />
        <Stat label="Tenants at risk (RAG)" value={summary.rag_at_risk.length} />
        <Stat label="Pending requests" value={summary.pending_requests_count} />
        <Stat label="Active overrides" value={summary.active_overrides.length} />
      </div>
      <h3 style={{ marginTop: 24 }}>Recent state transitions (7d)</h3>
      <table style={tableStyle}>
        <thead><tr><th style={thStyle}>Tenant</th><th style={thStyle}>Dimension</th><th style={thStyle}>From → To</th><th style={thStyle}>Metric / threshold</th><th style={thStyle}>When</th></tr></thead>
        <tbody>
          {summary.recent_transitions.map((t) => (
            <tr key={t.id}>
              <td style={tdStyle}><TenantLink id={t.tenant_id} /></td>
              <td style={tdStyle}>{t.dimension}</td>
              <td style={tdStyle}>{t.from_state} → {t.to_state}</td>
              <td style={tdStyle}>{t.metric_value} / {t.threshold_crossed}</td>
              <td style={tdStyle}>{new Date(t.triggered_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function AtRiskTab({ summary }: { summary: Summary }): JSX.Element {
  return (
    <section>
      <h3>Monthly-dimension at-risk</h3>
      <table style={tableStyle}>
        <thead><tr><th style={thStyle}>Tenant</th><th style={thStyle}>AI cost</th><th style={thStyle}>Chat volume</th><th style={thStyle}>Email volume</th><th style={thStyle}>Group invite</th></tr></thead>
        <tbody>
          {summary.tenants_at_risk.map((row, i) => (
            <tr key={`${row.tenant_id}:${i}`}>
              <td style={tdStyle}><TenantLink id={row.tenant_id} /></td>
              <td style={tdStyle}>{String(row.ai_cost_limit_state ?? "")}</td>
              <td style={tdStyle}>{String(row.chat_volume_limit_state ?? "")}</td>
              <td style={tdStyle}>{String(row.email_volume_limit_state ?? "")}</td>
              <td style={tdStyle}>{String(row.group_invite_limit_state ?? "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 style={{ marginTop: 24 }}>RAG cap at-risk</h3>
      <table style={tableStyle}>
        <thead><tr><th style={thStyle}>Tenant</th><th style={thStyle}>State</th><th style={thStyle}>Promoted</th><th style={thStyle}>Current</th><th style={thStyle}>Base cap</th></tr></thead>
        <tbody>
          {summary.rag_at_risk.map((r, i) => (
            <tr key={`${r.tenant_id}:${i}`}>
              <td style={tdStyle}><TenantLink id={r.tenant_id} /></td>
              <td style={tdStyle}>{String(r.rag_state ?? "")}</td>
              <td style={tdStyle}>{String(r.promoted_chunks_count ?? "")}</td>
              <td style={tdStyle}>{String(r.current_tenant_chunks_count ?? "")}</td>
              <td style={tdStyle}>{String(r.base_cap ?? "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function RequestsTab({ requests }: { requests: OverrideRequest[] }): JSX.Element {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState("");

  async function deny(id: string) {
    if (denyReason.length < 5) {
      alert("Deny reason must be at least 5 characters.");
      return;
    }
    setBusyId(id);
    const res = await adminFetch(`/api/admin/abuse/override-requests/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "deny", deny_reason: denyReason }),
    });
    const json = await res.json();
    setBusyId(null);
    if (!json.ok) alert(json.error ?? "deny failed");
    else window.location.reload();
  }

  return (
    <section>
      <h3>Pending override requests</h3>
      <div style={{ marginBottom: 8 }}>
        <label>Deny reason (used for any deny button):{" "}
          <input value={denyReason} onChange={(e) => setDenyReason(e.target.value)} style={{ padding: 4, width: 280 }} />
        </label>
      </div>
      <table style={tableStyle}>
        <thead><tr><th style={thStyle}>Tenant</th><th style={thStyle}>Dimension</th><th style={thStyle}>Kind</th><th style={thStyle}>State</th><th style={thStyle}>Reason</th><th style={thStyle}>Requested</th><th style={thStyle}>Actions</th></tr></thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td style={tdStyle}><TenantLink id={r.tenant_id} /></td>
              <td style={tdStyle}>{r.dimension}</td>
              <td style={tdStyle}>{r.requested_threshold_kind ?? "—"}</td>
              <td style={tdStyle}>{r.current_state}</td>
              <td style={tdStyle}>{r.reason}</td>
              <td style={tdStyle}>{new Date(r.requested_at).toLocaleString()}</td>
              <td style={tdStyle}>
                <button disabled={busyId === r.id} onClick={() => deny(r.id)} style={{ color: "#dc2626" }}>Deny</button>
                <span style={{ marginLeft: 8, color: "#6b7280" }}>Approve via POST /api/admin/abuse/overrides w/ resulting_request_id={r.id}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function OverridesTab({ summary }: { summary: Summary }): JSX.Element {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function revoke(id: string) {
    if (!confirm("Revoke this override? Caps revert immediately.")) return;
    setBusyId(id);
    const res = await adminFetch(`/api/admin/abuse/overrides/${id}`, {
      method: "DELETE",
    });
    const json = await res.json();
    setBusyId(null);
    if (!json.ok) alert(json.error ?? "revoke failed");
    else window.location.reload();
  }

  return (
    <section>
      <h3>Active overrides</h3>
      <table style={tableStyle}>
        <thead><tr><th style={thStyle}>Tenant</th><th style={thStyle}>Dimension</th><th style={thStyle}>Threshold</th><th style={thStyle}>Expires</th><th style={thStyle}>Actions</th></tr></thead>
        <tbody>
          {summary.active_overrides.map((o) => (
            <tr key={o.id}>
              <td style={tdStyle}><TenantLink id={o.tenant_id} /></td>
              <td style={tdStyle}>{o.dimension}</td>
              <td style={tdStyle}>{String(o.threshold_value)}</td>
              <td style={tdStyle}>{o.effective_to ?? "—"}</td>
              <td style={tdStyle}><button disabled={busyId === o.id} onClick={() => revoke(o.id)}>Revoke</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function DriftTab({ summary }: { summary: Summary }): JSX.Element {
  return (
    <section>
      <h3>Recompute drift (last 7 days)</h3>
      <p style={{ color: "#6b7280" }}>Each row is a nightly correction larger than the threshold (1¢ for ai_cost, 1 row for counts).</p>
      <table style={tableStyle}>
        <thead><tr><th style={thStyle}>Tenant</th><th style={thStyle}>Dimension</th><th style={thStyle}>Drift</th><th style={thStyle}>When</th></tr></thead>
        <tbody>
          {summary.recent_drift.map((d) => (
            <tr key={d.id}>
              <td style={tdStyle}><TenantLink id={d.tenant_id} /></td>
              <td style={tdStyle}>{d.dimension}</td>
              <td style={tdStyle}>{d.drift_amount}</td>
              <td style={tdStyle}>{new Date(d.detected_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div style={{ border: "1px solid #e5e7eb", padding: 12, borderRadius: 6 }}>
      <div style={{ color: "#6b7280", fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function TenantLink({ id }: { id: string }): JSX.Element {
  return <Link href={`/admin/abuse-monitoring/${id}`}>{id.slice(0, 8)}…</Link>;
}
