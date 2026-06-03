"use client";

// BP31 §32.6.5 — Platform admin help-triage console.
//
// Three tabs across all tenants:
//   - Bug submissions (filter by github_issue_state + triage_state)
//   - Feature requests (with decision actions)
//   - Help sessions (forensic review)

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";

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

export default function HelpTriagePage(): JSX.Element {
  const [tab, setTab] = useState<Tab>("bugs");
  const [bugs, setBugs] = useState<BugRow[]>([]);
  const [features, setFeatures] = useState<FeatureRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);

  useEffect(() => {
    (async () => {
      if (tab === "bugs") {
        const r = await adminFetch("/api/admin/help/bugs", undefined);
        if (r.ok) setBugs(((await r.json()) as { items: BugRow[] }).items);
      } else if (tab === "features") {
        const r = await adminFetch("/api/admin/help/features", undefined);
        if (r.ok) setFeatures(((await r.json()) as { items: FeatureRow[] }).items);
      } else {
        const r = await adminFetch("/api/admin/help/sessions", undefined);
        if (r.ok) setSessions(((await r.json()) as { items: SessionRow[] }).items);
      }
    })();
  }, [tab]);

  async function decide(featureId: string, decision: "accepted" | "rejected" | "deferred" | "duplicate"): Promise<void> {
    const notes = window.prompt(`Notes for decision "${decision}"?`) ?? "";
    const r = await adminFetch(`/api/admin/help/features/${featureId}`, {
      method: "PATCH",
      body: JSON.stringify({ decision, decision_notes: notes }),
    });
    if (r.ok) {
      const fresh = await adminFetch("/api/admin/help/features", undefined);
      if (fresh.ok) setFeatures(((await fresh.json()) as { items: FeatureRow[] }).items);
    }
  }

  return (
    <div className="px-6 py-6">
      <h1 className="text-2xl mb-4">Help triage</h1>
      <nav className="mb-6 border-b border-border">
        {(["bugs", "features", "sessions"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 bg-transparent border-none border-b-2 cursor-pointer font-${tab === t ? "semibold" : "normal"} ${
              tab === t ? "border-b-2 border-primary text-primary" : "border-b-2 border-transparent text-muted-foreground"
            }`}
          >
            {t === "bugs" ? "Bug submissions" : t === "features" ? "Feature requests" : "Help sessions"}
          </button>
        ))}
      </nav>

      {tab === "bugs" && (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="bg-muted text-left">
              <th className={thCls}>Submitted</th>
              <th className={thCls}>Tenant</th>
              <th className={thCls}>Source</th>
              <th className={thCls}>Where</th>
              <th className={thCls}>Score</th>
              <th className={thCls}>GitHub</th>
              <th className={thCls}>State</th>
              <th className={thCls}>Triage</th>
            </tr>
          </thead>
          <tbody>
            {bugs.map((r) => (
              <tr key={r.id} className="border-b border-border">
                <td className={tdCls}>{r.submitted_at.slice(0, 10)}</td>
                <td className={tdCls}>{r.tenant_id.slice(0, 8)}</td>
                <td className={tdCls}>{r.source_type}</td>
                <td className={tdCls}>{r.where_in_platform ?? "—"}</td>
                <td className={tdCls}>{r.confidence_score?.toFixed(2) ?? "—"}</td>
                <td className={tdCls}>
                  {r.github_issue_url ? <a href={r.github_issue_url} target="_blank" rel="noreferrer">#{r.github_issue_number}</a> : "—"}
                </td>
                <td className={tdCls}>{r.github_issue_state ?? "—"}</td>
                <td className={tdCls}>{r.triage_state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "features" && (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="bg-muted text-left">
              <th className={thCls}>Submitted</th>
              <th className={thCls}>Tenant</th>
              <th className={thCls}>What</th>
              <th className={thCls}>GitHub</th>
              <th className={thCls}>State</th>
              <th className={thCls}>Decision</th>
              <th className={thCls}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {features.map((r) => (
              <tr key={r.id} className="border-b border-border">
                <td className={tdCls}>{r.submitted_at.slice(0, 10)}</td>
                <td className={tdCls}>{r.tenant_id.slice(0, 8)}</td>
                <td className={tdCls}>{(r.what ?? "—").slice(0, 60)}</td>
                <td className={tdCls}>
                  {r.github_issue_url ? <a href={r.github_issue_url} target="_blank" rel="noreferrer">#{r.github_issue_number}</a> : "—"}
                </td>
                <td className={tdCls}>{r.github_issue_state ?? "—"}</td>
                <td className={tdCls}>{r.decision ?? <em>pending</em>}</td>
                <td className={tdCls}>
                  {!r.decision && (
                    <>
                      <button onClick={() => void decide(r.id, "accepted")} className={actionBtnCls}>Accept</button>
                      <button onClick={() => void decide(r.id, "rejected")} className={actionBtnCls}>Reject</button>
                      <button onClick={() => void decide(r.id, "deferred")} className={actionBtnCls}>Defer</button>
                      <button onClick={() => void decide(r.id, "duplicate")} className={actionBtnCls}>Duplicate</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "sessions" && (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="bg-muted text-left">
              <th className={thCls}>Started</th>
              <th className={thCls}>Tenant</th>
              <th className={thCls}>User</th>
              <th className={thCls}>Type</th>
              <th className={thCls}>Source</th>
              <th className={thCls}>Outcome</th>
              <th className={thCls}>Escalated</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((r) => (
              <tr key={r.id} className="border-b border-border">
                <td className={tdCls}>{r.started_at.slice(0, 16).replace("T", " ")}</td>
                <td className={tdCls}>{r.tenant_id.slice(0, 8)}</td>
                <td className={tdCls}>{r.user_id.slice(0, 8)}</td>
                <td className={tdCls}>{r.session_type}</td>
                <td className={tdCls}>{r.source_surface}</td>
                <td className={tdCls}>{r.outcome ?? <em>open</em>}</td>
                <td className={tdCls}>{r.escalated_to_human ? "yes" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const thCls = "px-3 py-2 font-semibold text-[12px] text-muted-foreground";
const tdCls = "px-3 py-2 align-top";
const actionBtnCls = "mr-1 px-2 py-0.5 text-[12px] border border-border rounded bg-card cursor-pointer";
