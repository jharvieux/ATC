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
import { assertPlatformAdminAreaPage } from "@/lib/auth/assert-platform-admin";

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

const thCls = "text-left px-2 py-2 border-b border-border";
const tdCls = "px-2 py-2 border-b border-muted";

export default async function SupervisorDashboardPage(): Promise<React.ReactElement> {
  await assertPlatformAdminAreaPage("supervisor");
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

  const driftColorClass =
    drift.delta_pct === null
      ? "text-muted-foreground"
      : drift.delta_pct > 10
        ? "text-red-600 dark:text-red-400"
        : drift.delta_pct < -10
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-muted-foreground";

  return (
    <main className="px-8 py-8 max-w-[1200px]">
      <h1>AI Supervisor Dashboard</h1>

      {/* §10.5 — Kill-switch state */}
      <section
        className={`mt-4 px-4 py-3 rounded-md border ${
          killSwitch?.global_paused
            ? "bg-red-50 dark:bg-red-950/20 border-red-600"
            : "bg-emerald-50 dark:bg-emerald-950/20 border-emerald-500"
        }`}
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
      <section className="mt-4 grid grid-cols-2 gap-4">
        <div className="px-4 py-3 border border-border rounded-md">
          <div className="text-[13px] text-muted-foreground">Regen budget exhausted (7d)</div>
          <div className="text-[28px] font-semibold">{regenExhausted}</div>
          <div className="text-[12px] text-muted-foreground">
            messages that hit max_regen — supervisor stopped retrying
          </div>
        </div>
        <div className="px-4 py-3 border border-border rounded-md">
          <div className="text-[13px] text-muted-foreground">Drift trend (flagged-message rate)</div>
          <div className="text-[28px] font-semibold">
            {drift.current_7d} <span className="text-[14px] text-muted-foreground">(prev {drift.prior_7d})</span>
          </div>
          <div className={`text-[12px] ${driftColorClass}`}>
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
      <section className="mt-8">
        <h2>Open Topic Escalations ({escalations.length})</h2>
        {escalations.length === 0 ? (
          <p>No open escalations.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className={thCls}>Summary</th>
                <th className={thCls}>Status</th>
                <th className={thCls}>Initiated by</th>
                <th className={thCls}>Opened</th>
                <th className={thCls}>Assigned</th>
              </tr>
            </thead>
            <tbody>
              {escalations.map((e) => (
                <tr key={e.id}>
                  <td className={tdCls}>{e.topic_summary}</td>
                  <td className={tdCls}>{e.status}</td>
                  <td className={tdCls}>{e.initiated_by ?? "—"}</td>
                  <td className={tdCls}>
                    {new Date(e.opened_at).toLocaleString()}
                  </td>
                  <td className={tdCls}>
                    {e.assigned_agent_id ? e.assigned_agent_id : "Unassigned"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Flagged messages by check type — last 7 days */}
      <section className="mt-8">
        <h2>Recent Flagged Messages by Check Type (last 7 days)</h2>
        {Object.keys(checkTypeCounts).length === 0 ? (
          <p>No flagged messages in the last 7 days.</p>
        ) : (
          <table className="border-collapse text-sm">
            <thead>
              <tr>
                <th className={thCls}>Check</th>
                <th className={thCls}>Count</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(checkTypeCounts)
                .sort(([, a], [, b]) => b - a)
                .map(([check, count]) => (
                  <tr key={check}>
                    <td className={tdCls}>{check}</td>
                    <td className={tdCls}>{count}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Per-persona metrics */}
      <section className="mt-8">
        <h2>Per-Persona Metrics</h2>
        {personaMetrics.length === 0 ? (
          <p>No messages yet.</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className={thCls}>Persona</th>
                <th className={thCls}>Responses</th>
                <th className={thCls}>Total Regens</th>
                <th className={thCls}>Thumbs Down</th>
                <th className={thCls}>Regen Rate</th>
              </tr>
            </thead>
            <tbody>
              {personaMetrics.map((m) => (
                <tr key={m.persona_id ?? "none"}>
                  <td className={tdCls}>
                    {m.persona_id ?? "(none)"}
                  </td>
                  <td className={tdCls}>{m.response_count}</td>
                  <td className={tdCls}>{m.regen_count}</td>
                  <td className={tdCls}>{m.thumbs_down_count}</td>
                  <td className={tdCls}>
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
