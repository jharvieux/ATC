// §23.7 — Resend webhook handler.
//
// Verifies RESEND_WEBHOOK_SECRET signature, then handles:
//   email.delivered   → update email_log status='delivered'
//   email.bounced     → soft: trigger retry Inngest job; hard: suppress + log
//   email.complained  → suppress + log
//   email.opened      → engagement metric (count only, no PII)
//   email.clicked     → engagement metric
//   email.sent        → no-op (already logged at send time)

import { createHmac, timingSafeEqual } from "crypto";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { inngest } from "@/inngest/client";

// Resend webhooks use Svix's signing scheme:
//   HMAC-SHA256(secret_bytes, `${svix-id}.${svix-timestamp}.${body}`)
//   then base64-encode the HMAC output.
//   Header `svix-signature` may carry multiple space-separated entries
//   like `v1,<base64> v1,<base64>` — any match is valid.
// The secret is stored as `whsec_<base64-of-secret-bytes>`; strip the
// prefix and base64-decode to get the raw key material.
//
// Reject messages older than 5 minutes per Svix's replay-protection guidance.
const SVIX_TOLERANCE_SECONDS = 5 * 60;

function decodeSecret(secret: string): Buffer {
  const stripped = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return Buffer.from(stripped, "base64");
}

export function verifyResendSignature(args: {
  body: string;
  msgId: string | null;
  timestamp: string | null;
  signatureHeader: string | null;
  secret: string;
  nowSeconds?: number;
}): boolean {
  const { body, msgId, timestamp, signatureHeader, secret } = args;
  if (!msgId || !timestamp || !signatureHeader) return false;

  // Reject messages outside the tolerance window — replay protection.
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(now - tsNum) > SVIX_TOLERANCE_SECONDS) return false;

  try {
    const key = decodeSecret(secret);
    const signedContent = `${msgId}.${timestamp}.${body}`;
    const expected = createHmac("sha256", key).update(signedContent).digest();

    // Header may carry multiple `v1,<base64>` entries separated by spaces.
    // Accept the request if ANY entry matches (timing-safe).
    for (const entry of signatureHeader.split(/\s+/)) {
      const [scheme, sig] = entry.split(",");
      if (scheme !== "v1" || !sig) continue;
      const actual = Buffer.from(sig, "base64");
      if (actual.length !== expected.length) continue;
      if (timingSafeEqual(expected, actual)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

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
