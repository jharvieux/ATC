// email_customer tool — emails the SIGNED-IN customer the info they asked for
// (deck-plan links, itinerary, quote summary) to their own account address.
//
// SECURITY: the recipient is NEVER chosen by the model. It is the signed-in
// customer's account email, resolved server-side in the chat route and passed
// in as dispatchCtx.customer_email. The tool schema has no recipient field, so
// the AI cannot be coaxed into emailing arbitrary addresses (no open relay).
// Anonymous turns (no customer_email) get a "ask them to sign in" result.
//
// Idempotency: a send is a side effect and is NOT idempotent. Tool-use in chat
// is single-pass per turn, and the recipient is the account holder, so the
// blast radius of an accidental double-send is the customer's own inbox.

import type { ToolDispatchContext, ToolResult } from "../dispatch";
import { sendEmail } from "@/lib/email/send";
import { ConciergeMessage } from "@/emails/ConciergeMessage";

// The persona's from-identity. Slug "marcus-cole" → marcus@ai-travelconcierge.com
// / "Marcus Cole". Local-part is the first slug segment (lowercased, alnum only).
const PLATFORM_EMAIL_DOMAIN = "ai-travelconcierge.com";

export function personaFromIdentity(slug: string | null | undefined): {
  fromAddress: string;
  fromName: string;
} {
  const segments = (slug ?? "").split("-").map((s) => s.trim()).filter(Boolean);
  const local = (segments[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "") || "concierge";
  const fromName =
    segments.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ") || "AI Travel Concierge";
  return { fromAddress: `${local}@${PLATFORM_EMAIL_DOMAIN}`, fromName };
}

type TenantRow = {
  id: string;
  legal_name: string;
  mailing_address: string | null;
  support_email: string | null;
};
type BrandingRow = {
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  slogan: string | null;
};

export async function emailCustomer(
  input: Record<string, unknown>,
  dispatchCtx: ToolDispatchContext,
): Promise<ToolResult> {
  const customerEmail = dispatchCtx.customer_email ?? null;
  if (!customerEmail) {
    return {
      content: JSON.stringify({
        sent: false,
        reason: "not_signed_in",
        message_for_customer:
          "Tell the customer you can email this to their account once they sign in (the email always goes to their own account address).",
      }),
      was_mutating: false,
    };
  }

  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  const body = typeof input.body_markdown === "string" ? input.body_markdown.trim() : "";
  if (!subject || !body) {
    return {
      content: JSON.stringify({ sent: false, reason: "missing_subject_or_body" }),
      was_mutating: false,
    };
  }

  const { db, ctx } = dispatchCtx;
  const tenantId = ctx.tenant_id;

  const { data: tenantData, error: tenantErr } = await db
    .from("tenants")
    .select("id, legal_name, mailing_address, support_email")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantErr) throw new Error(`email_customer: tenant load failed: ${tenantErr.message}`);
  if (!tenantData) {
    return { content: JSON.stringify({ sent: false, reason: "tenant_not_found" }), was_mutating: false };
  }
  const tenant = tenantData as TenantRow;

  const { data: brandingData } = await db
    .from("tenant_branding")
    .select("logo_url, primary_color, secondary_color, accent_color, slogan")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const branding = (brandingData as BrandingRow | null) ?? {
    logo_url: null,
    primary_color: null,
    secondary_color: null,
    accent_color: null,
    slogan: null,
  };

  const { fromAddress, fromName } = personaFromIdentity(dispatchCtx.persona_slug);
  const appUrl = process.env.PLATFORM_APP_URL ?? "https://app.ai-travelconcierge.com";
  const unsubscribeUrl = `${appUrl}/email/unsubscribe?token=concierge-message`;

  const jsx = ConciergeMessage({
    branding,
    tenant_legal_name: tenant.legal_name,
    tenant_business_address: tenant.mailing_address ?? "",
    persona_name: fromName,
    body,
    unsubscribe_url: unsubscribeUrl,
  });
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(jsx);

  const result = await sendEmail({
    db,
    tenant: {
      id: tenant.id,
      legal_name: tenant.legal_name,
      mailing_address: tenant.mailing_address,
      email_send_pattern: "platform_resend",
      // Full address (contains @) → resolveFromAddress honors it verbatim, on
      // the already-verified platform domain. From: "Marcus Cole <marcus@…>".
      email_from_address: fromAddress,
      email_from_name: fromName,
    },
    to: customerEmail,
    subject,
    template_id: "concierge_message",
    category: "transactional",
    html,
    ...(tenant.support_email ? { reply_to: tenant.support_email } : {}),
    ...(dispatchCtx.contact_id ? { contact_id: dispatchCtx.contact_id } : {}),
  });

  if (result.status === "sent") {
    return {
      content: JSON.stringify({ sent: true, recipient: "the customer's account email" }),
      was_mutating: true,
    };
  }
  return {
    content: JSON.stringify({ sent: false, reason: result.reason ?? result.status }),
    // Not mutating on failure: nothing was delivered (sendEmail still logs the
    // attempt internally, but no customer-visible side effect occurred here).
    was_mutating: false,
  };
}
