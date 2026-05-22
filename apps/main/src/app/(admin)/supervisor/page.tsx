"use server";

// §10.5 Supervisor Dashboard — platform admin, read-only
//
// Shows:
// - Open topic-level escalations (assigned + unassigned)
// - Recent flagged messages by check type (last 7 days)
// - Per-persona metrics: response count, regen rate
// - Per-tenant aggregates
// - Link to /admin/supervisor/review-queue (Prompt 12 lands the detail page)

import { createServiceRoleClient } from "@/lib/db/service-role-client";

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

async function getOpenEscalations(): Promise<EscalationTopic[]> {
  const db = createServiceRoleClient();
  const { data } = await db
    .from("escalation_topics")
    .select(
      "id, tenant_id, conversation_id, topic_summary, topic_tags, status, initiated_by, assigned_agent_id, opened_at",
    )
    .in("status", ["open", "in_progress"])
    .order("opened_at", { ascending: false })
    .limit(50);
  return (data ?? []) as EscalationTopic[];
}

async function getRecentFlaggedMessages(): Promise<FlaggedMessage[]> {
  const db = createServiceRoleClient();
  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data } = await db
    .from("messages")
    .select("id, tenant_id, supervisor_findings, created_at")
    .not("supervisor_findings", "is", null)
    .gte("created_at", sevenDaysAgo)
    .order("created_at", { ascending: false })
    .limit(100);
  return (data ?? []) as FlaggedMessage[];
}

async function getPersonaMetrics(): Promise<PersonaMetric[]> {
  const db = createServiceRoleClient();
  const { data } = await db
    .from("messages")
    .select("persona_id, supervisor_findings, feedback_score")
    .eq("role", "assistant")
    .limit(1000);

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

export default async function SupervisorDashboardPage() {
  const [escalations, flaggedMessages, personaMetrics] = await Promise.all([
    getOpenEscalations(),
    getRecentFlaggedMessages(),
    getPersonaMetrics(),
  ]);

  const checkTypeCounts = groupByCheckType(flaggedMessages);

  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif", maxWidth: "1200px" }}>
      <h1>AI Supervisor Dashboard</h1>

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
