// §26.6 — Operator alert fan-out.
//
// Routes a structured alert to:
//   • audit_log (always)
//   • Operator Slack webhook (if OPERATOR_SLACK_WEBHOOK_URL is set)
//   • Operator email (TODO — would route through lib/email/send.ts with
//     an Operator template; deferred until an operator-target table exists)
//
// Severity levels mirror the §26.7 incident priority matrix.

import { writeAuditLog } from "@/lib/audit/write";

export type OperatorAlertSeverity = "low" | "medium" | "high" | "critical";

export interface OperatorAlertInput {
  severity: OperatorAlertSeverity;
  signal: string;             // short identifier, e.g. "auth_failure_spike"
  detail: string;             // human-readable description
  payload?: Record<string, unknown>;
}

export async function sendOperatorAlert(input: OperatorAlertInput): Promise<void> {
  await writeAuditLog({
    actor_type: "system",
    action: `monitoring.alert.${input.signal}`,
    resource_type: "operator_alert",
    changes: {
      severity: input.severity,
      detail: input.detail,
      ...(input.payload ?? {}),
    },
  });

  // Slack webhook fan-out, best-effort.
  const webhook = process.env.OPERATOR_SLACK_WEBHOOK_URL;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `[${input.severity.toUpperCase()}] ${input.signal} — ${input.detail}`,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.warn(
        "[send-operator-alert] slack webhook failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Log to console as a final breadcrumb for log-tailers.
  console.warn(
    "[operator-alert] " +
      JSON.stringify({
        severity: input.severity,
        signal: input.signal,
        detail: input.detail,
        payload: input.payload ?? null,
      }),
  );
}
