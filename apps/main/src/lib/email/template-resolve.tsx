// #963 — Send-time resolution: tenant override → platform default.
//
// Senders call resolveEmailContent with the full variable set for the email
// type, then use `subject` directly and swap in the override body (when one
// exists) for the platform-default React template.
//
// Failure posture (issue #963 acceptance): fail loud, never fall back
// silently. A failed override READ throws — quietly sending the platform
// default when the tenant may have customized the email misrepresents the
// tenant. A render failure (unknown variable) also throws. Callers let the
// error propagate (Inngest retry / route 500) or log-and-skip the recipient;
// they never send an empty or half-rendered body.

import * as React from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EMAIL_TEMPLATE_REGISTRY, type EmailTemplateType } from "./template-registry";
import { renderTemplate, bodyTextToHtml } from "./template-engine";
import { BrandedLayout, type BrandedLayoutProps } from "@/emails/BrandedLayout";

export interface ResolvedEmailContent {
  subject: string;
  /** Variables already substituted. null = no body override; use the platform default body. */
  overrideBodyText: string | null;
}

export async function resolveEmailContent(args: {
  db: SupabaseClient;
  tenant_id: string;
  email_type: EmailTemplateType;
  variables: Record<string, string>;
}): Promise<ResolvedEmailContent> {
  const { db, tenant_id, email_type, variables } = args;

  // Service-role callers pass svc here; the explicit tenant_id eq is the
  // D-091 DB-layer constraint on that path. tenantClient callers get the
  // proxy's injected filter as well.
  const { data, error } = await db
    .from("tenant_email_templates")
    .select("subject_template, body_template")
    .eq("tenant_id", tenant_id)
    .eq("email_type", email_type)
    .maybeSingle();
  if (error) {
    throw new Error(`tenant_email_templates read failed (${email_type}): ${error.message}`);
  }
  const row = data as { subject_template: string | null; body_template: string | null } | null;

  const spec = EMAIL_TEMPLATE_REGISTRY[email_type];
  const subjectTemplate = row?.subject_template ?? spec.default_subject_template;

  return {
    subject: renderTemplate(subjectTemplate, variables),
    overrideBodyText: row?.body_template ? renderTemplate(row.body_template, variables) : null,
  };
}

/**
 * Render an override body inside the tenant's BrandedLayout so a customized
 * email keeps the logo/colors header and the CAN-SPAM footer (legal name,
 * address, unsubscribe link).
 */
export async function renderOverrideBodyInLayout(
  layout: Omit<BrandedLayoutProps, "children">,
  overrideBodyText: string,
): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  // bodyTextToHtml HTML-escapes every line, so this innerHTML carries no
  // tenant-typed markup — only <p>/<br> structure added by the converter.
  return renderToStaticMarkup(
    <BrandedLayout {...layout}>
      <div dangerouslySetInnerHTML={{ __html: bodyTextToHtml(overrideBodyText) }} />
    </BrandedLayout>,
  );
}
