"use client";

// BP31 §32.6.5 — Platform admin help-triage console.
//
// Three tabs across all tenants:
//   - Bug submissions (filter by github_issue_state + triage_state)
//   - Feature requests (with decision actions)
//   - Help sessions (forensic review)

import { useEffect, useState } from "react";

type Tab = "bugs" | "features" | "sessions";

interface BugRow {
  id: string;
  tenant_id: string;
  source_type: string;
  where_in_platform: string | null;
  confidence_score: number | null;
  github_issue_number: number | null;
  github_issue_url: string | null;
  github_issue_state: string | null;
  triage_state: string;
  submitted_at: string;
}

interface FeatureRow {
  id: string;
  tenant_id: string;
  source_type: string;
  what: string | null;
  github_issue_number: number | null;
  github_issue_url: string | null;
  github_issue_state: string | null;
  decision: string | null;
  submitted_at: string;
}

interface SessionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  session_type: string;
  source_surface: string;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  escalated_to_human: boolean;
}

async function adminFetch(path: string, init?: RequestInit, adminUserId?: string): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (adminUserId) headers.set("x-admin-user-id", adminUserId);
  if (init?.body) headers.set("Content-Type", "application/json");
  return fetch(path, { ...init, headers });
}

export default function HelpTriagePage(): JSX.Element {
  const [tab, setTab] = useState<Tab>("bugs");
  const [bugs, setBugs] = useState<BugRow[]>([]);
  const [features, setFeatures] = useState<FeatureRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [adminUserId, setAdminUserId] = useState("");

  useEffect(() => {
    setAdminUserId(typeof window !== "undefined" ? localStorage.getItem("admin-user-id") ?? "" : "");
  }, []);

  useEffect(() => {
    if (!adminUserId) return;
    (async () => {
      if (tab === "bugs") {
        const r = await adminFetch("/api/admin/help/bugs", undefined, adminUserId);
        if (r.ok) setBugs(((await r.json()) as { items: BugRow[] }).items);
      } else if (tab === "features") {
        const r = await adminFetch("/api/admin/help/features", undefined, adminUserId);
        if (r.ok) setFeatures(((await r.json()) as { items: FeatureRow[] }).items);
      } else {
        const r = await adminFetch("/api/admin/help/sessions", undefined, adminUserId);
        if (r.ok) setSessions(((await r.json()) as { items: SessionRow[] }).items);
      }
    })();
  }, [tab, adminUserId]);

  async function decide(featureId: string, decision: "accepted" | "rejected" | "deferred" | "duplicate"): Promise<void> {
    const notes = window.prompt(`Notes for decision "${decision}"?`) ?? "";
    const r = await adminFetch(
      `/api/admin/help/features/${featureId}`,
      { method: "PATCH", body: JSON.stringify({ decision, decision_notes: notes }) },
      adminUserId,
    );
    if (r.ok) {
      const fresh = await adminFetch("/api/admin/help/features", undefined, adminUserId);
      if (fresh.ok) setFeatures(((await fresh.json()) as { items: FeatureRow[] }).items);
    }
  }

  if (!adminUserId) {
    return (
      <div style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <p>Set localStorage <code>admin-user-id</code> to your platform-admin UUID, then reload.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: "1.5rem", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 24, marginBottom: "1rem" }}>Help triage</h1>
      <nav style={{ marginBottom: "1.5rem", borderBottom: "1px solid #e5e7eb" }}>
        {(["bugs", "features", "sessions"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "0.5rem 1rem",
              background: "transparent",
              border: "none",
              borderBottom: tab === t ? "2px solid #4f46e5" : "2px solid transparent",
              cursor: "pointer",
              fontWeight: tab === t ? 600 : 400,
            }}
          >
            {t === "bugs" ? "Bug submissions" : t === "features" ? "Feature requests" : "Help sessions"}
          </button>
        ))}
      </nav>

      {tab === "bugs" && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f9fafb", textAlign: "left" }}>
              <th style={th}>Submitted</th>
              <th style={th}>Tenant</th>
              <th style={th}>Source</th>
              <th style={th}>Where</th>
              <th style={th}>Score</th>
              <th style={th}>GitHub</th>
              <th style={th}>State</th>
              <th style={th}>Triage</th>
            </tr>
          </thead>
          <tbody>
            {bugs.map((r) => (
              <tr key={r.id} style={{ borderBottom: "1px solid #e5e7eb" }}>
                <td style={td}>{r.submitted_at.slice(0, 10)}</td>
                <td style={td}>{r.tenant_id.slice(0, 8)}</td>
                <td style={td}>{r.source_type}</td>
                <td style={td}>{r.where_in_platform ?? "—"}</td>
                <td style={td}>{r.confidence_score?.toFixed(2) ?? "—"}</td>
                <td style={td}>
                  {r.github_issue_url ? <a href={r.github_issue_url} target="_blank" rel="noreferrer">#{r.github_issue_number}</a> : "—"}
                </td>
                <td style={td}>{r.github_issue_state ?? "—"}</td>
                <td style={td}>{r.triage_state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "features" && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f9fafb", textAlign: "left" }}>
              <th style={th}>Submitted</th>
              <th style={th}>Tenant</th>
              <th style={th}>What</th>
              <th style={th}>GitHub</th>
              <th style={th}>State</th>
              <th style={th}>Decision</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {features.map((r) => (
              <tr key={r.id} style={{ borderBottom: "1px solid #e5e7eb" }}>
                <td style={td}>{r.submitted_at.slice(0, 10)}</td>
                <td style={td}>{r.tenant_id.slice(0, 8)}</td>
                <td style={td}>{(r.what ?? "—").slice(0, 60)}</td>
                <td style={td}>
                  {r.github_issue_url ? <a href={r.github_issue_url} target="_blank" rel="noreferrer">#{r.github_issue_number}</a> : "—"}
                </td>
                <td style={td}>{r.github_issue_state ?? "—"}</td>
                <td style={td}>{r.decision ?? <em>pending</em>}</td>
                <td style={td}>
                  {!r.decision && (
                    <>
                      <button onClick={() => void decide(r.id, "accepted")} style={actionBtn}>Accept</button>
                      <button onClick={() => void decide(r.id, "rejected")} style={actionBtn}>Reject</button>
                      <button onClick={() => void decide(r.id, "deferred")} style={actionBtn}>Defer</button>
                      <button onClick={() => void decide(r.id, "duplicate")} style={actionBtn}>Duplicate</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "sessions" && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#f9fafb", textAlign: "left" }}>
              <th style={th}>Started</th>
              <th style={th}>Tenant</th>
              <th style={th}>User</th>
              <th style={th}>Type</th>
              <th style={th}>Source</th>
              <th style={th}>Outcome</th>
              <th style={th}>Escalated</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((r) => (
              <tr key={r.id} style={{ borderBottom: "1px solid #e5e7eb" }}>
                <td style={td}>{r.started_at.slice(0, 16).replace("T", " ")}</td>
                <td style={td}>{r.tenant_id.slice(0, 8)}</td>
                <td style={td}>{r.user_id.slice(0, 8)}</td>
                <td style={td}>{r.session_type}</td>
                <td style={td}>{r.source_surface}</td>
                <td style={td}>{r.outcome ?? <em>open</em>}</td>
                <td style={td}>{r.escalated_to_human ? "yes" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const th: React.CSSProperties = { padding: "0.5rem 0.75rem", fontWeight: 600, fontSize: 12, color: "#6b7280" };
const td: React.CSSProperties = { padding: "0.5rem 0.75rem", verticalAlign: "top" };
const actionBtn: React.CSSProperties = {
  marginRight: 4,
  padding: "2px 8px",
  fontSize: 12,
  border: "1px solid #d1d5db",
  borderRadius: 4,
  background: "white",
  cursor: "pointer",
};
