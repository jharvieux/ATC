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
  const { data: logRow } = await svc
    .from("email_log")
    .select("id, tenant_id, to_email")
    .eq("resend_message_id", resendMessageId)
    .maybeSingle();

  if (!logRow) {
    // Not found — could be a race or an email sent outside this system; ignore.
    return new Response("OK", { status: 200 });
  }

  const logId = (logRow as { id: string; tenant_id: string; to_email: string }).id;
  const tenantId = (logRow as { id: string; tenant_id: string; to_email: string }).tenant_id;
  const toEmail = (logRow as { id: string; tenant_id: string; to_email: string }).to_email;
  const now = new Date().toISOString();

  switch (event.type) {
    case "email.delivered":
      await svc
        .from("email_log")
        .update({ status: "delivered", delivered_at: now })
        .eq("id", logId);
      break;

    case "email.bounced": {
      const bounceType = (event.data.bounce as { type?: string } | undefined)?.type;
      const bounceMessage = (event.data.bounce as { message?: string } | undefined)?.message ?? "unknown";

      if (bounceType === "hard") {
        await svc
          .from("email_log")
          .update({ status: "hard_bounced", bounced_at: now, bounce_reason: bounceMessage })
          .eq("id", logId);
        // Suppress future sends to this address for this tenant
        await svc.from("email_suppressions").upsert(
          { tenant_id: tenantId, email_address: toEmail, reason: "hard_bounce", suppressed_at: now },
          { onConflict: "tenant_id,email_address,reason" },
        );
      } else {
        // Soft bounce — trigger retry Inngest job
        await svc
          .from("email_log")
          .update({ status: "soft_bounced", bounced_at: now, bounce_reason: bounceMessage })
          .eq("id", logId);
        await inngest.send({
          name: "email/soft.bounce.retry",
          data: { email_log_id: logId, tenant_id: tenantId, attempt: 1 },
        });
      }
      break;
    }

    case "email.complained":
      await svc
        .from("email_log")
        .update({ status: "complained", complained_at: now })
        .eq("id", logId);
      await svc.from("email_suppressions").upsert(
        { tenant_id: tenantId, email_address: toEmail, reason: "complaint", suppressed_at: now },
        { onConflict: "tenant_id,email_address,reason" },
      );
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
