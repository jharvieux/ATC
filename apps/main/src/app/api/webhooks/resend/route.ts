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

  // Look up the email_log row
  const { data: logRow, error: logErr } = await svc
    .from("email_log")
    .select("id, tenant_id, to_email, retry_of")
    .eq("resend_message_id", resendMessageId)
    .maybeSingle();

  if (logErr) return new Response("DB error", { status: 500 });
  if (!logRow) {
    // Not found — could be a race or an email sent outside this system; ignore.
    return new Response("OK", { status: 200 });
  }

  type LogRow = { id: string; tenant_id: string; to_email: string; retry_of: string | null };
  const logId = (logRow as LogRow).id;
  const tenantId = (logRow as LogRow).tenant_id;
  const toEmail = (logRow as LogRow).to_email;
  // §23.7/#1611 — a soft bounce on a re-send row must NOT start a fresh retry
  // chain: the original send's chain self-drives its +6h/+12h/+24h schedule and
  // reads this row's status directly. Status is still recorded below for that read.
  const isRetrySend = (logRow as LogRow).retry_of !== null;
  const now = new Date().toISOString();

  switch (event.type) {
    case "email.delivered":
      await safeAwait(svc
        .from("email_log")
        .update({ status: "delivered", delivered_at: now })
        .eq("id", logId), "email_log.update");
      break;

    case "email.bounced": {
      const bounceType = (event.data.bounce as { type?: string } | undefined)?.type;
      const bounceMessage = (event.data.bounce as { message?: string } | undefined)?.message ?? "unknown";

      if (bounceType === "hard") {
        await safeAwait(svc
          .from("email_log")
          .update({ status: "hard_bounced", bounced_at: now, bounce_reason: bounceMessage })
          .eq("id", logId), "email_log.update");
        // Suppress future sends to this address for this tenant
        await safeAwait(svc.from("email_suppressions").upsert(
          { tenant_id: tenantId, email_address: toEmail, reason: "hard_bounce", suppressed_at: now },
          { onConflict: "tenant_id,email_address,reason" },
        ), "email_suppressions.upsert");
      } else {
        // Soft bounce — record status; trigger a retry chain only for original
        // sends (re-send rows are driven by the existing chain, not a new one).
        await safeAwait(svc
          .from("email_log")
          .update({ status: "soft_bounced", bounced_at: now, bounce_reason: bounceMessage })
          .eq("id", logId), "email_log.update");
        if (!isRetrySend) {
          await inngest.send({
            // Deterministic id → Inngest dedupes a Svix REDELIVERY of this bounce to
            // a single retry-chain start (installed inngest@4 MinimalEventPayload.id:
            // "if an event with the same ID is sent again, it will not invoke
            // functions"). Without it, two concurrent attempt-1 runs would race the
            // completion marker and compound scheduleNext down the whole chain.
            id: `soft-retry:${logId}:attempt:1`,
            name: "email/soft.bounce.retry",
            data: { email_log_id: logId, tenant_id: tenantId, attempt: 1 },
          });
        }
      }
      break;
    }

    case "email.complained":
      await safeAwait(svc
        .from("email_log")
        .update({ status: "complained", complained_at: now })
        .eq("id", logId), "email_log.update");
      await safeAwait(svc.from("email_suppressions").upsert(
        { tenant_id: tenantId, email_address: toEmail, reason: "complaint", suppressed_at: now },
        { onConflict: "tenant_id,email_address,reason" },
      ), "email_suppressions.upsert");
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

  return new Response("OK", { status: 200 });
}
