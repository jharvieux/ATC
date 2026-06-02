// §10.5 Supervisor Dashboard — platform admin, read-only Server Component.
//
// Shows:
// - Kill-switch state (global pause)
// - Open topic-level escalations (assigned + unassigned)
// - Flagged messages grouped by check type (last 7 days)
// - Regen budget exhaustion (messages that hit max_regen)
// - Drift trend (last-7-day vs prior-7-day flagged-rate delta)
// - Per-persona metrics: response count, regen rate, thumbs-down count
// - Link to /admin/supervisor/review-queue

import React from "react";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait, SupabaseMutationError } from "@/lib/db/safe-mutation";

interface KillSwitchState {
  global_paused: boolean;
  global_paused_at: string | null;
  global_paused_reason: string | null;
}

interface DriftWindow {
  current_7d: number;
  prior_7d: number;
  delta_pct: number | null;
}

// Helpers are exported for isolated unit testing (each must surface read
// errors, not degrade to zeroes — #561). Mirrors the page-helper export
// convention used by signup/complete/page.tsx.
export async function getKillSwitchState(): Promise<KillSwitchState | null> {
  const db = createServiceRoleClient();
  const data = await safeAwait(
    db
      .from("ai_kill_switch_state")
      .select("global_paused, global_paused_at, global_paused_reason")
      .eq("id", 1)
      .maybeSingle(),
    "ai_kill_switch_state.select.global",
  );
  return (data as KillSwitchState | null) ?? null;
}

export async function getRegenBudgetExhausted(): Promise<number> {
  const db = createServiceRoleClient();
  // Convention from run-supervisor: max regen = 2. A finding with
  // regen_count >= 2 means budget exhausted.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await db
    .from("messages")
    .select("id", { count: "exact", head: true })
    .not("supervisor_findings", "is", null)
    .gte("created_at", sevenDaysAgo)
    .filter("supervisor_findings->regen_count", "gte", "2");
  if (error) throw new SupabaseMutationError("messages.count.regen_exhausted", error);
  return count ?? 0;
}

export async function getDriftTrend(): Promise<DriftWindow> {
  const db = createServiceRoleClient();
  const now = Date.now();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const fourteenDaysAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();

  const [current, prior] = await Promise.all([
    db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .not("supervisor_findings", "is", null)
      .gte("created_at", sevenDaysAgo),
    db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .not("supervisor_findings", "is", null)
      .gte("created_at", fourteenDaysAgo)
      .lt("created_at", sevenDaysAgo),
  ]);

  if (current.error)
    throw new SupabaseMutationError("messages.count.drift_current", current.error);
  if (prior.error)
    throw new SupabaseMutationError("messages.count.drift_prior", prior.error);

  const c = current.count ?? 0;
  const p = prior.count ?? 0;
  const delta_pct = p === 0 ? null : ((c - p) / p) * 100;
  return { current_7d: c, prior_7d: p, delta_pct };
}

type EscalationTopic = {
  id: string;
  tenant_id: string;
  conversation_id: string;
  topic_summary: string;
  topic_tags: string[] | null;
  status: string;
  initiated_by: string | null;
  assigned_agent_id: string | null;
  opened_at: string;
};

type FlaggedMessage = {
  id: string;
  tenant_id: string;
  supervisor_findings: {
    findings: Array<{ check: string; severity: string; details: string }>;
    final_action: string;
    regen_count: number;
  } | null;
  created_at: string;
};

type PersonaMetric = {
  persona_id: string | null;
  response_count: number;
  regen_count: number;
  thumbs_down_count: number;
};

export async function getOpenEscalations(): Promise<EscalationTopic[]> {
  const db = createServiceRoleClient();
  const data = await safeAwait(
    db
      .from("escalation_topics")
      .select(
        "id, tenant_id, conversation_id, topic_summary, topic_tags, status, initiated_by, assigned_agent_id, opened_at",
      )
      .in("status", ["open", "in_progress"])
      .order("opened_at", { ascending: false })
      .limit(50),
    "escalation_topics.select.open",
  );
  return (data ?? []) as EscalationTopic[];
}

export async function getRecentFlaggedMessages(): Promise<FlaggedMessage[]> {
  const db = createServiceRoleClient();
  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const data = await safeAwait(
    db
      .from("messages")
      .select("id, tenant_id, supervisor_findings, created_at")
      .not("supervisor_findings", "is", null)
      .gte("created_at", sevenDaysAgo)
      .order("created_at", { ascending: false })
      .limit(100),
    "messages.select.recent_flagged",
  );
  return (data ?? []) as FlaggedMessage[];
}

export async function getPersonaMetrics(): Promise<PersonaMetric[]> {
  const db = createServiceRoleClient();
  const data = await safeAwait(
    db
      .from("messages")
      .select("persona_id, supervisor_findings, feedback_score")
      .eq("role", "assistant")
      .limit(1000),
    "messages.select.persona_metrics",
  );

  if (!data) return [];

  const metricMap = new Map<string | null, PersonaMetric>();
  for (const msg of data) {
    const key = msg.persona_id as string | null;
    const existing = metricMap.get(key) ?? {
      persona_id: key,
      response_count: 0,
      regen_count: 0,
      thumbs_down_count: 0,
    };
    existing.response_count++;
    if (
      msg.supervisor_findings &&
      typeof msg.supervisor_findings === "object" &&
      "regen_count" in msg.supervisor_findings
    ) {
      existing.regen_count += (msg.supervisor_findings as { regen_count: number }).regen_count;
    }
    if (msg.feedback_score === -1) existing.thumbs_down_count++;
    metricMap.set(key, existing);
  }

  return Array.from(metricMap.values()).sort(
    (a, b) => b.response_count - a.response_count,
  );
}

// Count flagged findings by check type across recent messages
function groupByCheckType(
  messages: FlaggedMessage[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const msg of messages) {
    const findings = msg.supervisor_findings?.findings ?? [];
    for (const f of findings) {
      if (f.severity !== "info") {
        counts[f.check] = (counts[f.check] ?? 0) + 1;
      }
    }
  }
  return counts;
}

export default async function SupervisorDashboardPage(): Promise<React.ReactElement> {
  const [escalations, flaggedMessages, personaMetrics, killSwitch, regenExhausted, drift] =
    await Promise.all([
      getOpenEscalations(),
      getRecentFlaggedMessages(),
      getPersonaMetrics(),
      getKillSwitchState(),
      getRegenBudgetExhausted(),
      getDriftTrend(),
    ]);

  const checkTypeCounts = groupByCheckType(flaggedMessages);

  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif", maxWidth: "1200px" }}>
      <h1>AI Supervisor Dashboard</h1>

      {/* §10.5 — Kill-switch state */}
      <section
        style={{
          marginTop: "1rem",
          padding: "0.75rem 1rem",
          background: killSwitch?.global_paused ? "#fee2e2" : "#ecfdf5",
          border: `1px solid ${killSwitch?.global_paused ? "#dc2626" : "#10b981"}`,
          borderRadius: 6,
        }}
      >
        <strong>Global AI kill-switch:</strong>{" "}
        {killSwitch?.global_paused ? "PAUSED" : "active"}
        {killSwitch?.global_paused && killSwitch.global_paused_at && (
          <>
            {" "}— since {new Date(killSwitch.global_paused_at).toLocaleString()}
            {killSwitch.global_paused_reason && (
              <> ({killSwitch.global_paused_reason})</>
            )}
          </>
        )}
      </section>

      {/* §10.5 — Regen budget exhaustion + drift trend (top-line counters) */}
      <section
        style={{
          marginTop: "1rem",
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: "1rem",
        }}
      >
        <div style={{ padding: "0.75rem 1rem", border: "1px solid #e5e7eb", borderRadius: 6 }}>
          <div style={{ fontSize: 13, color: "#6b7280" }}>Regen budget exhausted (7d)</div>
          <div style={{ fontSize: 28, fontWeight: 600 }}>{regenExhausted}</div>
          <div style={{ fontSize: 12, color: "#6b7280" }}>
            messages that hit max_regen — supervisor stopped retrying
          </div>
        </div>
        <div style={{ padding: "0.75rem 1rem", border: "1px solid #e5e7eb", borderRadius: 6 }}>
          <div style={{ fontSize: 13, color: "#6b7280" }}>Drift trend (flagged-message rate)</div>
          <div style={{ fontSize: 28, fontWeight: 600 }}>
            {drift.current_7d} <span style={{ fontSize: 14, color: "#6b7280" }}>(prev {drift.prior_7d})</span>
          </div>
          <div
            style={{
              fontSize: 12,
              color:
                drift.delta_pct === null
                  ? "#6b7280"
                  : drift.delta_pct > 10
                    ? "#dc2626"
                    : drift.delta_pct < -10
                      ? "#10b981"
                      : "#6b7280",
            }}
          >
            {drift.delta_pct === null
              ? "no prior-period baseline"
              : `${drift.delta_pct >= 0 ? "+" : ""}${drift.delta_pct.toFixed(0)}% vs prior 7d`}
          </div>
        </div>
      </section>

      {/* Review queue link — detail page lands in Prompt 12 */}
      <p>
        <a href="/admin/supervisor/review-queue">
          → Go to Sampling Review Queue
        </a>
      </p>

      {/* Open escalations */}
      <section style={{ marginTop: "2rem" }}>
        <h2>Open Topic Escalations ({escalations.length})</h2>
        {escalations.length === 0 ? (
          <p>No open escalations.</p>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "0.5rem", borderBottom: "1px solid #ccc" }}>Summary</th>
                <th style={{ textAlign: "left", padding: "0.5rem", borderBottom: "1px solid #ccc" }}>Status</th>
                <th style={{ textAlign: "left", padding: "0.5rem", borderBottom: "1px solid #ccc" }}>Initiated by</th>
                <th style={{ textAlign: "left", padding: "0.5rem", borderBottom: "1px solid #ccc" }}>Opened</th>
                <th style={{ textAlign: "left", padding: "0.5rem", borderBottom: "1px solid #ccc" }}>Assigned</th>
              </tr>
            </thead>
            <tbody>
              {escalations.map((e) => (
                <tr key={e.id}>
                  <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>{e.topic_summary}</td>
                  <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>{e.status}</td>
                  <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>{e.initiated_by ?? "—"}</td>
                  <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
                    {new Date(e.opened_at).toLocaleString()}
                  </td>
                  <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
                    {e.assigned_agent_id ? e.assigned_agent_id : "Unassigned"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Flagged messages by check type — last 7 days */}
      <section style={{ marginTop: "2rem" }}>
        <h2>Recent Flagged Messages by Check Type (last 7 days)</h2>
        {Object.keys(checkTypeCounts).length === 0 ? (
          <p>No flagged messages in the last 7 days.</p>
        ) : (
          <table style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "0.5rem", borderBottom: "1px solid #ccc" }}>Check</th>
                <th style={{ textAlign: "left", padding: "0.5rem", borderBottom: "1px solid #ccc" }}>Count</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(checkTypeCounts)
                .sort(([, a], [, b]) => b - a)
                .map(([check, count]) => (
                  <tr key={check}>
                    <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>{check}</td>
                    <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>{count}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Per-persona metrics */}
      <section style={{ marginTop: "2rem" }}>
        <h2>Per-Persona Metrics</h2>
        {personaMetrics.length === 0 ? (
          <p>No messages yet.</p>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "0.5rem", borderBottom: "1px solid #ccc" }}>Persona</th>
                <th style={{ textAlign: "left", padding: "0.5rem", borderBottom: "1px solid #ccc" }}>Responses</th>
                <th style={{ textAlign: "left", padding: "0.5rem", borderBottom: "1px solid #ccc" }}>Total Regens</th>
                <th style={{ textAlign: "left", padding: "0.5rem", borderBottom: "1px solid #ccc" }}>Thumbs Down</th>
                <th style={{ textAlign: "left", padding: "0.5rem", borderBottom: "1px solid #ccc" }}>Regen Rate</th>
              </tr>
            </thead>
            <tbody>
              {personaMetrics.map((m) => (
                <tr key={m.persona_id ?? "none"}>
                  <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
                    {m.persona_id ?? "(none)"}
                  </td>
                  <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>{m.response_count}</td>
                  <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>{m.regen_count}</td>
                  <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>{m.thumbs_down_count}</td>
                  <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
                    {m.response_count > 0
                      ? `${((m.regen_count / m.response_count) * 100).toFixed(1)}%`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
