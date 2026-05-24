// §26.6 — Operator alert fan-out.
//
// Routes a structured alert to:
//   • audit_log (always — durable record regardless of delivery channel)
//   • Operator email via Resend (if OPERATOR_ALERT_EMAIL and RESEND_API_KEY
//     are set). Best-effort: a Resend failure is logged but doesn't propagate
//     because the audit_log write already captured the signal.
//   • console.warn breadcrumb (always — visible to log tailers / Vercel
//     runtime logs even when neither email nor audit_log persisted).
//
// Email recipient: a single platform-admin inbox (OPERATOR_ALERT_EMAIL).
// Subject convention: "[<SEVERITY>] <signal> — <detail-first-line>" so
// inbox rules can filter by severity and signal.
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

const RESEND_API_URL = "https://api.resend.com/emails";

function resolveFromAddress(): string {
  const fromAddress = process.env.RESEND_FROM_ADDRESS_DEFAULT;
  if (fromAddress) return fromAddress;
  const fromDomain = process.env.RESEND_FROM_DOMAIN;
  if (fromDomain) return `alerts@${fromDomain}`;
  // Last-resort default — Resend's testing domain accepts mail without DNS
  // setup, so a dev environment with neither var set still gets an alert.
  return "onboarding@resend.dev";
}

function renderHtml(input: OperatorAlertInput): string {
  const payloadJson = input.payload ? JSON.stringify(input.payload, null, 2) : "";
  return (
    "<!doctype html><html><body style=\"font-family:Arial,sans-serif;color:#222;\">" +
    `<h2 style="margin:0 0 12px 0;color:${severityColor(input.severity)};">` +
    `[${input.severity.toUpperCase()}] ${escapeHtml(input.signal)}</h2>` +
    `<p style="font-size:15px;line-height:1.5;">${escapeHtml(input.detail)}</p>` +
    (payloadJson
      ? `<pre style="background:#f4f4f4;padding:12px;border-radius:6px;font-size:13px;` +
        `overflow:auto;">${escapeHtml(payloadJson)}</pre>`
      : "") +
    "<p style=\"color:#888;font-size:12px;margin-top:24px;\">" +
    "Sent by AI Travel Concierge platform monitoring. " +
    "audit_log carries the durable record." +
    "</p></body></html>"
  );
}

function severityColor(s: OperatorAlertSeverity): string {
  return s === "critical" ? "#7f1d1d" : s === "high" ? "#b45309" : s === "medium" ? "#ca8a04" : "#4b5563";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function sendOperatorAlert(input: OperatorAlertInput): Promise<void> {
  // 1. audit_log — durable, always.
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

  // 2. Email fan-out (best-effort).
  const to = process.env.OPERATOR_ALERT_EMAIL;
  const apiKey = process.env.RESEND_API_KEY;
  if (to && apiKey) {
    try {
      const detailFirstLine = input.detail.split("\n")[0] ?? input.detail;
      const subject =
        `[${input.severity.toUpperCase()}] ${input.signal} — ` +
        (detailFirstLine.length > 90 ? `${detailFirstLine.slice(0, 87)}...` : detailFirstLine);

      const res = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: resolveFromAddress(),
          to: [to],
          subject,
          html: renderHtml(input),
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn(
          "[send-operator-alert] Resend returned %d: %s",
          res.status,
          text.slice(0, 200),
        );
      }
    } catch (err) {
      console.warn(
        "[send-operator-alert] email send failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  } else if (!to) {
    // Quiet — no recipient configured. audit_log + console.warn below are
    // the operator's surface in this case.
  } else if (!apiKey) {
    console.warn("[send-operator-alert] OPERATOR_ALERT_EMAIL set but RESEND_API_KEY missing");
  }

  // 3. Console breadcrumb (always — visible in Vercel logs / log tailers).
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
