// §23.7 — Resend webhook handler.
//
// Verifies RESEND_WEBHOOK_SECRET signature, then handles:
//   email.delivered   → update email_log status='delivered'
//   email.bounced     → soft: trigger retry Inngest job; hard: suppress + log
//   email.complained  → suppress + log
//   email.opened      → engagement metric (count only, no PII)
//   email.clicked     → engagement metric
//   email.sent        → no-op (already logged at send time)

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { inngest } from "@/inngest/client";
import { verifyResendSignature } from "@/lib/webhooks/resend-signature";
import { safeAwait } from "@/lib/db/safe-mutation";

// D-091 P1 #38 — Svix signature verifier lives in lib/webhooks/ so the
// route file only exports POST (Next.js Route export contract).

interface ResendEvent {
  type: string;
  created_at?: string;
  data: {
    email_id?: string;
    bounce?: { type?: string; message?: string };
    [key: string]: unknown;
  };
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[resend-webhook] RESEND_WEBHOOK_SECRET not set");
    return new Response("Webhook secret not configured", { status: 500 });
  }

  const msgId = req.headers.get("svix-id");
  const timestamp = req.headers.get("svix-timestamp");
  const signatureHeader = req.headers.get("svix-signature");
  const body = await req.text();

  if (!verifyResendSignature({ body, msgId, timestamp, signatureHeader, secret })) {
    return new Response("Invalid signature", { status: 401 });
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(body) as ResendEvent;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const svc = createServiceRoleClient();
  const resendMessageId = event.data.email_id;

  if (!resendMessageId) {
    return new Response("Missing email_id", { status: 400 });
  }

  const isStatusEvent =
    event.type === "email.delivered"
    || event.type === "email.bounced"
    || event.type === "email.complained";
  let eventCreatedAt: string | null = null;
  if (isStatusEvent) {
    if (typeof event.created_at !== "string") {
      return new Response("Missing created_at", { status: 400 });
    }
    const parsedCreatedAt = new Date(event.created_at);
    if (Number.isNaN(parsedCreatedAt.getTime())) {
      return new Response("Invalid created_at", { status: 400 });
    }
    eventCreatedAt = parsedCreatedAt.toISOString();
  }

  // Look up the email_log row
  const { data: logRow, error: logErr } = await svc
    // d091-allow:service-role-tenant resend_message_id is DB-unique and resolves the tenant before tenant-scoped processing begins
    .from("email_log")
    .select("id, tenant_id")
    .eq("resend_message_id", resendMessageId)
    .maybeSingle();

  if (logErr) return new Response("DB error", { status: 500 });
  if (!logRow) {
    // Not found — could be a race or an email sent outside this system; ignore.
    return new Response("OK", { status: 200 });
  }

  type LogRow = { id: string; tenant_id: string };
  const logId = (logRow as LogRow).id;
  const tenantId = (logRow as LogRow).tenant_id;

  let status: "delivered" | "soft_bounced" | "hard_bounced" | "complained" | null = null;
  let bounceReason: string | null = null;

  switch (event.type) {
    case "email.delivered":
      status = "delivered";
      break;

    case "email.bounced": {
      const bounceType = (event.data.bounce as { type?: string } | undefined)?.type;
      status = bounceType === "hard" ? "hard_bounced" : "soft_bounced";
      bounceReason = (event.data.bounce as { message?: string } | undefined)?.message ?? "unknown";
      break;
    }

    case "email.complained":
      status = "complained";
      break;

    case "email.opened":
      // Engagement metric — log count, no PII stored beyond what's already in email_log.
      // event.type narrowed to the literal "email.opened" in this branch — CodeQL
      // sees a constant flow into the log argument.
      console.info(`[resend-webhook] engagement: type=email.opened log_id=${logId}`);
      break;
    case "email.clicked":
      console.info(`[resend-webhook] engagement: type=email.clicked log_id=${logId}`);
      break;

    case "email.sent":
      // Already logged at send time — no-op.
      break;

    default: {
      // Untrusted event.type fell through every known case. Don't log the
      // unknown value — it's the most aggressive log-injection surface in
      // this file. Sentry breadcrumbs (already wired) capture the raw
      // event for engineering inspection.
      console.warn("[resend-webhook] unhandled event type (raw value omitted from log; see Sentry breadcrumbs)");
      break;
    }
  }

  if (status && eventCreatedAt && msgId) {
    const rows = await safeAwait(
      svc.rpc("apply_resend_status_event", {
        p_tenant_id: tenantId,
        p_email_log_id: logId,
        p_event_id: msgId,
        p_event_created_at: eventCreatedAt,
        p_status: status,
        p_bounce_reason: bounceReason,
      }),
      "apply_resend_status_event",
    );
    const result = (rows as Array<{
      outcome: "applied" | "duplicate" | "stale" | "not_found";
      soft_retry_eligible: boolean;
    }> | null)?.[0];
    if (!result) throw new Error("apply_resend_status_event returned no row");

    if (status === "soft_bounced" && result.soft_retry_eligible) {
      await inngest.send({
        // The RPC also returns true for an exact redelivery while soft_bounced
        // remains current. This deterministic id makes that recovery handoff a
        // no-op if the original Inngest send already succeeded.
        id: `soft-retry:${logId}:attempt:1`,
        name: "email/soft.bounce.retry",
        data: { email_log_id: logId, tenant_id: tenantId, attempt: 1 },
      });
    }
  }

  return new Response("OK", { status: 200 });
}
