// #890 Phase 1 — Resend INBOUND webhook (email.received).
//
// Receives replies sent to persona addresses (marcus@ai-travelconcierge.com),
// resolves the owning tenant, forwards a copy to the tenant's support_email,
// and persists the message to inbound_emails. Unresolved mail is persisted
// with tenant_id NULL and surfaced on the platform-admin list — never dropped.
//
// Security posture (D-091 #2/#10/#12/#20/#23/#24):
//   - Svix signature verification, fail-closed when the secret is unset.
//     Replay: the verifier enforces the 5-minute svix-timestamp tolerance
//     window, and the inbound_emails.provider_message_id UNIQUE row dedups
//     beyond it.
//   - The dedup row is written AFTER resolve+forward completes ("fully
//     processed", not "received"). A transient forward failure returns 500 so
//     the provider retries; the forward's deterministic Idempotency-Key
//     (inbound_forward:<provider id>) makes that retry double-send-safe.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { verifyResendSignature } from "@/lib/webhooks/resend-signature";
import {
  fetchReceivedEmail,
  extractReferencedMessageIds,
  resolveInboundTenant,
  attachInboundToTimeline,
} from "@/lib/email/inbound";
import { sendTenantNotification } from "@/lib/email/notifications";
import { escapeHtml } from "@/lib/utils";

interface InboundEvent {
  type: string;
  data: {
    email_id?: string;
    from?: string;
    to?: string[];
    subject?: string;
    // Some Resend payloads carry auth verdicts; tolerated when absent.
    spf?: { result?: string };
    dkim?: { result?: string };
    [key: string]: unknown;
  };
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[resend-inbound] RESEND_INBOUND_WEBHOOK_SECRET not set");
    return new Response("Webhook secret not configured", { status: 500 });
  }

  const msgId = req.headers.get("svix-id");
  const timestamp = req.headers.get("svix-timestamp");
  const signatureHeader = req.headers.get("svix-signature");
  const body = await req.text();

  if (!verifyResendSignature({ body, msgId, timestamp, signatureHeader, secret })) {
    return new Response("Invalid signature", { status: 401 });
  }

  let event: InboundEvent;
  try {
    event = JSON.parse(body) as InboundEvent;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // This endpoint subscribes to email.received only; acknowledge anything
  // else so a misconfigured subscription doesn't retry forever.
  if (event.type !== "email.received") return new Response("OK", { status: 200 });

  const providerMessageId = event.data.email_id;
  const fromEmail = event.data.from;
  if (!providerMessageId || !fromEmail) return new Response("Missing email_id or from", { status: 400 });

  const svc = createServiceRoleClient();

  // Fast-path dedup/replay: an existing row means a prior delivery was fully
  // processed (row insert is the LAST step below).
  const { data: existing, error: existingErr } = await svc
    // d091-allow:service-role-tenant dedup key is the globally-unique provider message id; tenant unknown until resolution below
    .from("inbound_emails")
    .select("id")
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();
  if (existingErr) return new Response("DB error", { status: 500 });
  if (existing) return new Response("OK", { status: 200 });

  // Body + headers need a separate Receiving API fetch (webhook is
  // metadata-only). Best-effort: null still leaves sender-fallback resolution.
  const content = await fetchReceivedEmail(providerMessageId);
  const referencedIds = content ? extractReferencedMessageIds(content.headers) : [];

  const resolution = await resolveInboundTenant({ db: svc, referencedIds, fromEmail });

  // #1728 — CRM timeline attach. ONLY the spoof-resistant "references" path may
  // attach to a tenant's CRM (design "Security notes"); the "sender" fallback
  // forwards but never attaches. Attaching before the forward means the reply
  // is recorded even if the forward is later suppressed/rate-limited, and lets
  // the forward carry a link to the conversation it landed on.
  let attachedContactId: string | null = null;
  if (resolution.method === "references" && resolution.contact_id) {
    const attach = await attachInboundToTimeline({
      db: svc,
      tenant_id: resolution.tenant_id,
      contact_id: resolution.contact_id,
      providerMessageId,
      subject: event.data.subject ?? null,
      text: content?.text ?? null,
    });
    if (attach.status === "error") {
      // No inbound_emails row written yet, so the provider retry reprocesses;
      // the attach is idempotent on source_message_id.
      console.error("[resend-inbound] timeline attach failed, returning 500 for provider retry");
      return new Response("Timeline attach failed", { status: 500 });
    }
    attachedContactId = resolution.contact_id;
  }

  let forwardedEmailLogId: string | null = null;
  if (resolution.method !== "unresolved") {
    const { data: tenantRow, error: tenantErr } = await svc
      .from("tenants")
      .select("support_email")
      .eq("id", resolution.tenant_id)
      .maybeSingle();
    if (tenantErr) return new Response("DB error", { status: 500 });
    const supportEmail = (tenantRow as { support_email: string | null } | null)?.support_email;

    if (supportEmail) {
      const subject = event.data.subject?.trim() || "(no subject)";
      const fwd = await sendTenantNotification({
        db: svc,
        tenant_id: resolution.tenant_id,
        to: supportEmail,
        subject: `[Concierge reply] ${subject}`,
        html: buildForwardHtml({
          fromEmail,
          toEmail: event.data.to?.[0] ?? "",
          subject,
          textBody: content?.text ?? null,
          contactId: attachedContactId,
        }),
        category: "transactional",
        template_id: "inbound_persona_forward",
        reply_to: fromEmail,
        idempotencyKey: `inbound_forward:${providerMessageId}`,
        ...(resolution.contact_id ? { contact_id: resolution.contact_id } : {}),
      });
      if (fwd.status === "failed") {
        // Transient (Resend 5xx / key misconfig): no inbound_emails row was
        // written, so the provider's webhook retry reprocesses cleanly.
        console.error("[resend-inbound] forward failed, returning 500 for provider retry");
        return new Response("Forward failed", { status: 500 });
      }
      // suppressed/rate_limited are terminal policy outcomes — the message is
      // still persisted below so it isn't lost.
      if (fwd.status === "sent") forwardedEmailLogId = fwd.email_log_id ?? null;
    }
  }

  // D-091 #10 — the dedup row is written last so it means "fully processed".
  const { error: insertErr } = await svc.from("inbound_emails").insert({
    provider_message_id: providerMessageId,
    tenant_id: resolution.method === "unresolved" ? null : resolution.tenant_id,
    contact_id: resolution.method === "unresolved" ? null : resolution.contact_id,
    from_email: fromEmail,
    to_email: event.data.to?.[0] ?? "",
    subject: event.data.subject ?? null,
    text_body: content?.text ?? null,
    resolution: resolution.method,
    spf_result: event.data.spf?.result ?? null,
    dkim_result: event.data.dkim?.result ?? null,
    raw_payload: event.data,
    forwarded_email_log_id: forwardedEmailLogId,
  });
  if (insertErr) {
    // 23505 = concurrent duplicate delivery already fully processed this
    // message between our fast-path check and now — success, not an error.
    if ((insertErr as { code?: string }).code === "23505") return new Response("OK", { status: 200 });
    // Anything else: fail loud so the provider retries; the forward's
    // Idempotency-Key keeps the retry from double-sending.
    console.error("[resend-inbound] inbound_emails insert failed: %s", insertErr.message);
    return new Response("DB error", { status: 500 });
  }

  return new Response("OK", { status: 200 });
}

// Everything interpolated is either escaped inbound text or a fixed label —
// a hostile reply body/subject renders as literal text in the forward.
function buildForwardHtml(args: {
  fromEmail: string;
  toEmail: string;
  subject: string;
  textBody: string | null;
  contactId: string | null;
}): string {
  const bodyHtml = args.textBody
    ? escapeHtml(args.textBody).replace(/\r?\n/g, "<br>")
    : "<em>Body unavailable — view the message in the Resend dashboard.</em>";
  const lines = [
    `<p>A customer replied to your concierge's email address.</p>`,
    `<p><strong>From:</strong> ${escapeHtml(args.fromEmail)}<br>`,
    `<strong>To:</strong> ${escapeHtml(args.toEmail)}<br>`,
    `<strong>Subject:</strong> ${escapeHtml(args.subject)}</p>`,
    `<hr>`,
    `<p>${bodyHtml}</p>`,
    `<p><em>Reply to this email to respond directly to the customer.</em></p>`,
  ];
  // #1728 — when the reply was attached to the CRM timeline, link the TA to the
  // contact where the "Draft reply" action lives. contactId is a UUID from our
  // own DB (not attacker-controlled), but escape it anyway for defense in depth.
  if (args.contactId) {
    const base = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.ai-travelconcierge.com";
    const url = `${base}/crm/contacts/${encodeURIComponent(args.contactId)}`;
    lines.push(
      `<p>This reply was added to the customer's CRM timeline — ` +
        `<a href="${escapeHtml(url)}">open the contact to draft a reply</a>.</p>`,
    );
  }
  return lines.join("\n");
}
