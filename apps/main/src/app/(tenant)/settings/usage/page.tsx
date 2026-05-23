"use client";

// §27.11 — Tenant settings → usage. Shows current-period gauges, RAG
// status, and a "request override" form that POSTs to
// /api/tenant/override-requests.

import { useState, useEffect } from "react";

type DimRow = {
  dimension: "ai_cost" | "chat_volume" | "email_volume" | "group_invite";
  current: string;
  state: string;
  thresholds: { soft1: string; soft2: string; hard: string };
};
type Rag = {
  state: string;
  current_chunks: number;
  promoted_chunks: number;
  base_cap: number;
  approaching: number;
  effective_cap: number;
};
type Summary = { dims: DimRow[]; rag: Rag; period: string };

type Request_ = {
  id: string;
  dimension: string;
  requested_threshold_kind: string | null;
  current_state: string;
  status: string;
  requested_at: string;
  reviewed_at: string | null;
  deny_reason: string | null;
};

const DIM_LABEL = {
  ai_cost: "AI usage cost",
  chat_volume: "Chat volume",
  email_volume: "Email volume",
  group_invite: "Group invitations",
} as const;

export default function UsagePage(): JSX.Element {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [requests, setRequests] = useState<Request_[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state.
  const [selDim, setSelDim] = useState<DimRow["dimension"] | "rag_cap">("ai_cost");
  const [selKind, setSelKind] = useState<"soft1" | "soft2" | "hard" | "base_cap" | "">("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void Promise.all([
      authFetch("/api/tenant/usage").then((r) => r.json()),
      authFetch("/api/tenant/override-requests").then((r) => r.json()),
    ])
      .then(([u, q]) => {
        if (u.error) setError(u.error);
        else setSummary({ dims: u.dims, rag: u.rag, period: u.period });
        if (!q.error) setRequests(q.items);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  async function submitRequest() {
    if (reason.length < 5) { alert("Reason must be ≥ 5 characters."); return; }
    setSubmitting(true);
    const currentState =
      selDim === "rag_cap"
        ? summary?.rag.state ?? "ok"
        : summary?.dims.find((d) => d.dimension === selDim)?.state ?? "ok";
    const res = await authFetch("/api/tenant/override-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dimension: selDim,
        requested_threshold_kind: selKind || null,
        current_state: currentState,
        reason,
      }),
    });
    const json = await res.json();
    setSubmitting(false);
    if (!json.ok) alert(json.error ?? "submit failed");
    else { setReason(""); window.location.reload(); }
  }

  if (loading) return <main style={pageStyle}><p>Loading…</p></main>;
  if (error) return <main style={pageStyle}><p style={{ color: "#dc2626" }}>{error}</p></main>;
  if (!summary) return <main style={pageStyle}><p>No data.</p></main>;

  return (
    <main style={pageStyle}>
      <h1>Usage &amp; limits</h1>
      <p style={{ color: "#555" }}>Current billing period: {summary.period}</p>

      <h2 style={{ marginTop: 24 }}>Monthly dimensions</h2>
      <table style={tableStyle}>
        <thead><tr><th style={thStyle}>Dimension</th><th style={thStyle}>Current</th><th style={thStyle}>Soft1</th><th style={thStyle}>Soft2</th><th style={thStyle}>Hard</th><th style={thStyle}>State</th></tr></thead>
        <tbody>
          {summary.dims.map((d) => (
            <tr key={d.dimension}>
              <td style={tdStyle}>{DIM_LABEL[d.dimension]}</td>
              <td style={tdStyle}>{d.current}</td>
              <td style={tdStyle}>{d.thresholds.soft1}</td>
              <td style={tdStyle}>{d.thresholds.soft2}</td>
              <td style={tdStyle}>{d.thresholds.hard}</td>
              <td style={{ ...tdStyle, color: stateColor(d.state), fontWeight: 600 }}>{d.state}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: 24 }}>RAG knowledge base</h2>
      <p>
        State: <strong style={{ color: stateColor(summary.rag.state) }}>{summary.rag.state}</strong> —
        {" "}{summary.rag.current_chunks} of {summary.rag.effective_cap} chunks used
        {" "}(base cap {summary.rag.base_cap}, promoted +{summary.rag.promoted_chunks}).
      </p>

      <h2 style={{ marginTop: 24 }}>Request an override</h2>
      <p style={{ color: "#6b7280", marginTop: 0 }}>
        Submitted requests go to platform admins. Approved overrides take effect immediately and last 30 days by default.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select value={selDim} onChange={(e) => setSelDim(e.target.value as DimRow["dimension"] | "rag_cap")}>
          <option value="ai_cost">AI cost</option>
          <option value="chat_volume">Chat volume</option>
          <option value="email_volume">Email volume</option>
          <option value="group_invite">Group invite</option>
          <option value="rag_cap">RAG cap</option>
        </select>
        <select value={selKind} onChange={(e) => setSelKind(e.target.value as typeof selKind)}>
          <option value="">— threshold kind (optional) —</option>
          <option value="soft1">soft1</option>
          <option value="soft2">soft2</option>
          <option value="hard">hard</option>
          <option value="base_cap">base_cap (RAG)</option>
        </select>
        <input
          placeholder="reason (≥5 chars)" value={reason}
          onChange={(e) => setReason(e.target.value)}
          style={{ padding: 4, width: 360 }}
        />
        <button disabled={submitting} onClick={submitRequest}>Submit request</button>
      </div>

      <h2 style={{ marginTop: 32 }}>Your request history</h2>
      <table style={tableStyle}>
        <thead><tr><th style={thStyle}>Dimension</th><th style={thStyle}>Kind</th><th style={thStyle}>Status</th><th style={thStyle}>Requested</th><th style={thStyle}>Reviewed</th><th style={thStyle}>Deny reason</th></tr></thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td style={tdStyle}>{r.dimension}</td>
              <td style={tdStyle}>{r.requested_threshold_kind ?? "—"}</td>
              <td style={tdStyle}>{r.status}</td>
              <td style={tdStyle}>{new Date(r.requested_at).toLocaleString()}</td>
              <td style={tdStyle}>{r.reviewed_at ? new Date(r.reviewed_at).toLocaleString() : "—"}</td>
              <td style={tdStyle}>{r.deny_reason ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

const pageStyle: React.CSSProperties = { padding: 24, maxWidth: 980, margin: "0 auto" };
const tableStyle: React.CSSProperties = { width: "100%", borderCollapse: "collapse", marginTop: 8 };
const thStyle: React.CSSProperties = { textAlign: "left", padding: 8, borderBottom: "1px solid #e5e7eb", background: "#f3f4f6" };
const tdStyle: React.CSSProperties = { padding: 8, borderBottom: "1px solid #f3f4f6" };

function stateColor(s: string): string {
  if (s === "ok") return "#16a34a";
  if (s === "soft1" || s === "approaching") return "#ca8a04";
  if (s === "soft2") return "#ea580c";
  return "#dc2626";
}

async function authFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const token = typeof window !== "undefined"
    ? (localStorage.getItem("sb-access-token") ?? "")
    : "";
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
