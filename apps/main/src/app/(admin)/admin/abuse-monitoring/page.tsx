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

const thCls = "text-left px-2.5 py-2.5 border-b border-border bg-muted font-semibold text-sm";
const tdCls = "px-2.5 py-2.5 border-b border-muted text-sm";

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

  if (loading) return <main className="px-6 py-6 max-w-[1200px] mx-auto"><p>Loading…</p></main>;
  if (error) return <main className="px-6 py-6 max-w-[1200px] mx-auto"><p className="text-red-600 dark:text-red-400">{error}</p></main>;
  if (!summary) return <main className="px-6 py-6 max-w-[1200px] mx-auto"><p>No data.</p></main>;

  return (
    <main className="px-6 py-6 max-w-[1200px] mx-auto">
      <h1>Abuse monitoring</h1>
      <p className="text-muted-foreground">§27 — SaaS abuse / cost-control dashboard. Updated on each page load.</p>

      <nav className="flex gap-3 mt-4 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 border-none bg-transparent cursor-pointer text-sm ${
              tab === t
                ? "border-b-2 border-primary font-semibold text-primary"
                : "border-b-2 border-transparent font-normal text-muted-foreground"
            }`}
          >
            {TAB_LABEL[t]}
            {t === "requests" && summary.pending_requests_count > 0 && (
              <span className="ml-1.5 bg-red-600 text-white rounded-full px-2 py-0.5 text-[12px]">
                {summary.pending_requests_count}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="mt-5">
        {tab === "overview" && <OverviewTab summary={summary} />}
        {tab === "at_risk" && <AtRiskTab summary={summary} />}
        {tab === "requests" && <RequestsTab requests={requests} />}
        {tab === "active_overrides" && <OverridesTab summary={summary} />}
        {tab === "drift_log" && <DriftTab summary={summary} />}
      </div>
    </main>
  );
}

function OverviewTab({ summary }: { summary: Summary }): JSX.Element {
  return (
    <section>
      <div className="grid grid-cols-4 gap-3">
        <Stat label="Tenants at risk (monthly)" value={summary.tenants_at_risk.length} />
        <Stat label="Tenants at risk (RAG)" value={summary.rag_at_risk.length} />
        <Stat label="Pending requests" value={summary.pending_requests_count} />
        <Stat label="Active overrides" value={summary.active_overrides.length} />
      </div>
      <h3 className="mt-6">Recent state transitions (7d)</h3>
      <table className="w-full border-collapse mt-4">
        <thead><tr><th className={thCls}>Tenant</th><th className={thCls}>Dimension</th><th className={thCls}>From → To</th><th className={thCls}>Metric / threshold</th><th className={thCls}>When</th></tr></thead>
        <tbody>
          {summary.recent_transitions.map((t) => (
            <tr key={t.id}>
              <td className={tdCls}><TenantLink id={t.tenant_id} /></td>
              <td className={tdCls}>{t.dimension}</td>
              <td className={tdCls}>{t.from_state} → {t.to_state}</td>
              <td className={tdCls}>{t.metric_value} / {t.threshold_crossed}</td>
              <td className={tdCls}>{new Date(t.triggered_at).toLocaleString()}</td>
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
      <table className="w-full border-collapse mt-4">
        <thead><tr><th className={thCls}>Tenant</th><th className={thCls}>AI cost</th><th className={thCls}>Chat volume</th><th className={thCls}>Email volume</th><th className={thCls}>Group invite</th></tr></thead>
        <tbody>
          {summary.tenants_at_risk.map((row, i) => (
            <tr key={`${row.tenant_id}:${i}`}>
              <td className={tdCls}><TenantLink id={row.tenant_id} /></td>
              <td className={tdCls}>{String(row.ai_cost_limit_state ?? "")}</td>
              <td className={tdCls}>{String(row.chat_volume_limit_state ?? "")}</td>
              <td className={tdCls}>{String(row.email_volume_limit_state ?? "")}</td>
              <td className={tdCls}>{String(row.group_invite_limit_state ?? "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="mt-6">RAG cap at-risk</h3>
      <table className="w-full border-collapse mt-4">
        <thead><tr><th className={thCls}>Tenant</th><th className={thCls}>State</th><th className={thCls}>Promoted</th><th className={thCls}>Current</th><th className={thCls}>Base cap</th></tr></thead>
        <tbody>
          {summary.rag_at_risk.map((r, i) => (
            <tr key={`${r.tenant_id}:${i}`}>
              <td className={tdCls}><TenantLink id={r.tenant_id} /></td>
              <td className={tdCls}>{String(r.rag_state ?? "")}</td>
              <td className={tdCls}>{String(r.promoted_chunks_count ?? "")}</td>
              <td className={tdCls}>{String(r.current_tenant_chunks_count ?? "")}</td>
              <td className={tdCls}>{String(r.base_cap ?? "")}</td>
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
      <div className="mb-2">
        <label>Deny reason (used for any deny button):{" "}
          <input
            value={denyReason}
            onChange={(e) => setDenyReason(e.target.value)}
            className="px-2 py-1 border border-border rounded text-sm w-[280px]"
          />
        </label>
      </div>
      <table className="w-full border-collapse mt-4">
        <thead><tr><th className={thCls}>Tenant</th><th className={thCls}>Dimension</th><th className={thCls}>Kind</th><th className={thCls}>State</th><th className={thCls}>Reason</th><th className={thCls}>Requested</th><th className={thCls}>Actions</th></tr></thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td className={tdCls}><TenantLink id={r.tenant_id} /></td>
              <td className={tdCls}>{r.dimension}</td>
              <td className={tdCls}>{r.requested_threshold_kind ?? "—"}</td>
              <td className={tdCls}>{r.current_state}</td>
              <td className={tdCls}>{r.reason}</td>
              <td className={tdCls}>{new Date(r.requested_at).toLocaleString()}</td>
              <td className={tdCls}>
                <button
                  disabled={busyId === r.id}
                  onClick={() => deny(r.id)}
                  className="text-red-600 dark:text-red-400 bg-transparent border-none cursor-pointer text-sm disabled:opacity-50"
                >
                  Deny
                </button>
                <span className="ml-2 text-muted-foreground text-[12px]">Approve via POST /api/admin/abuse/overrides w/ resulting_request_id={r.id}</span>
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
      <table className="w-full border-collapse mt-4">
        <thead><tr><th className={thCls}>Tenant</th><th className={thCls}>Dimension</th><th className={thCls}>Threshold</th><th className={thCls}>Expires</th><th className={thCls}>Actions</th></tr></thead>
        <tbody>
          {summary.active_overrides.map((o) => (
            <tr key={o.id}>
              <td className={tdCls}><TenantLink id={o.tenant_id} /></td>
              <td className={tdCls}>{o.dimension}</td>
              <td className={tdCls}>{String(o.threshold_value)}</td>
              <td className={tdCls}>{o.effective_to ?? "—"}</td>
              <td className={tdCls}>
                <button
                  disabled={busyId === o.id}
                  onClick={() => revoke(o.id)}
                  className="px-3 py-1 border border-border rounded text-sm disabled:opacity-50"
                >
                  Revoke
                </button>
              </td>
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
      <p className="text-muted-foreground">Each row is a nightly correction larger than the threshold (1¢ for ai_cost, 1 row for counts).</p>
      <table className="w-full border-collapse mt-4">
        <thead><tr><th className={thCls}>Tenant</th><th className={thCls}>Dimension</th><th className={thCls}>Drift</th><th className={thCls}>When</th></tr></thead>
        <tbody>
          {summary.recent_drift.map((d) => (
            <tr key={d.id}>
              <td className={tdCls}><TenantLink id={d.tenant_id} /></td>
              <td className={tdCls}>{d.dimension}</td>
              <td className={tdCls}>{d.drift_amount}</td>
              <td className={tdCls}>{new Date(d.detected_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="border border-border p-3 rounded-md">
      <div className="text-muted-foreground text-[12px]">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}

function TenantLink({ id }: { id: string }): JSX.Element {
  return <Link href={`/admin/abuse-monitoring/${id}`}>{id.slice(0, 8)}…</Link>;
}
