// BP37 §37.3.2 — Email channel for task reminders.
//
// Loads the tenant + recipient + task, resolves subject/body via
// resolveEmailContent (#970 — tenant overrides), renders TaskReminder
// template for the platform-default path, calls sendEmail (BP23).
// Returns the email log status. The reminder cron records this as
// 'delivered' / 'suppressed' / 'failed'.

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email/send";
import { formatMailingAddress } from "@/lib/email/format-mailing-address";
import { resolveEmailContent, renderOverrideBodyInLayout } from "@/lib/email/template-resolve";
import { TaskReminder } from "@/emails/TaskReminder";
import type { BrandedLayoutProps } from "@/emails/BrandedLayout";

type TenantRow = {
  id: string;
  legal_name: string;
  mailing_address: string | null;
};

type UserRow = {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
};

type TaskRow = {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  due_at: string | null;
  priority: string;
  assigned_to_user_id: string | null;
  created_by_user_id: string | null;
};

export type EmailReminderOutcome =
  | { status: "sent" }
  | { status: "suppressed"; reason: string }
  | { status: "failed"; reason: string };

export async function sendTaskReminderEmail(args: {
  svc: SupabaseClient;
  task_id: string;
  tenant_id: string;
  reminder_id: string;
}): Promise<EmailReminderOutcome> {
  const { svc, task_id, tenant_id, reminder_id } = args;

  const { data: taskData } = await svc
    .from("tasks")
    .select("id, tenant_id, title, description, due_at, priority, assigned_to_user_id, created_by_user_id")
    .eq("id", task_id)
    .maybeSingle();
  if (!taskData) return { status: "failed", reason: "task_not_found" };
  const task = taskData as TaskRow;
  if (task.tenant_id !== tenant_id) return { status: "failed", reason: "tenant_mismatch" };

  const recipientUserId = task.assigned_to_user_id ?? task.created_by_user_id;
  if (!recipientUserId) return { status: "suppressed", reason: "no_recipient_user" };

  const { data: userData } = await svc
    // d091-allow:service-role-tenant — identity-table read by PK; tenant already verified at line 62 (task.tenant_id !== tenant_id guard); user may belong to any tenant calling the cron.
    .from("users")
    .select("id, email, first_name, last_name")
    .eq("id", recipientUserId)
    .maybeSingle();
  if (!userData) return { status: "failed", reason: "recipient_user_not_found" };
  const user = userData as UserRow;
  if (!user.email) return { status: "suppressed", reason: "recipient_has_no_email" };

  const { data: tenantData } = await svc
    .from("tenants")
    // #1190: email_* / send-pattern / resend-key live on tenant_branding.
    .select("id, legal_name, mailing_address")
    .eq("id", tenant_id)
    .maybeSingle();
  if (!tenantData) return { status: "failed", reason: "tenant_not_found" };
  const tenant = tenantData as TenantRow;

  const { data: brandingData } = await svc
    .from("tenant_branding")
    // #1190: email send config (send-pattern, resend key, from-address/name) is
    // on tenant_branding, not tenants.
    .select("logo_url, primary_color, secondary_color, accent_color, slogan, email_send_pattern, tenant_resend_api_key_encrypted, email_from_address, email_from_name")
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  const branding = (brandingData as {
    logo_url: string | null;
    primary_color: string | null;
    secondary_color: string | null;
    accent_color: string | null;
    slogan: string | null;
    email_send_pattern: "platform_resend" | "tenant_resend" | null;
    tenant_resend_api_key_encrypted: string | null;
    email_from_address: string | null;
    email_from_name: string | null;
  } | null) ?? { logo_url: null, primary_color: null, secondary_color: null, accent_color: null, slogan: null, email_send_pattern: null, tenant_resend_api_key_encrypted: null, email_from_address: null, email_from_name: null };

  const appUrl = process.env.PLATFORM_APP_URL ?? "https://app.example.com";
  const taskUrl = `${appUrl}/crm/tasks/${task.id}`;
  // §37.3.2 — operational reminder; suppression honors unsubscribe.
  const unsubscribeUrl = `${appUrl}/email/unsubscribe?token=task-reminder`;

  const recipientName = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email;

  const layoutProps: Omit<BrandedLayoutProps, "children"> = {
    branding: {
      logo_url: branding.logo_url ?? null,
      primary_color: branding.primary_color ?? null,
      secondary_color: branding.secondary_color ?? null,
      accent_color: branding.accent_color ?? null,
      slogan: branding.slogan ?? null,
    },
    tenant_legal_name: tenant.legal_name,
    tenant_business_address: formatMailingAddress(tenant.mailing_address),
    unsubscribe_url: unsubscribeUrl,
  };

  let subject: string;
  let html: string;
  try {
    const resolved = await resolveEmailContent({
      db: svc,
      tenant_id: tenant.id,
      email_type: "task_reminder",
      variables: {
        recipient_name: recipientName,
        task_title: task.title,
        task_description: task.description ?? "",
        due_at: task.due_at ?? "",
        priority: task.priority,
        task_url: taskUrl,
      },
    });
    subject = resolved.subject;

    if (resolved.overrideBodyText !== null) {
      html = await renderOverrideBodyInLayout(layoutProps, resolved.overrideBodyText);
    } else {
      const { renderToStaticMarkup } = await import("react-dom/server");
      html = renderToStaticMarkup(TaskReminder({
        branding,
        tenant_legal_name: tenant.legal_name,
        tenant_business_address: formatMailingAddress(tenant.mailing_address),
        recipient_name: recipientName,
        task_title: task.title,
        task_description: task.description,
        due_at: task.due_at,
        priority: task.priority,
        task_url: taskUrl,
        unsubscribe_url: unsubscribeUrl,
      }));
    }
  } catch (err) {
    console.error(
      `[send-reminder-email] template resolution failed for tenant=${tenant_id} task=${task_id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { status: "failed", reason: "template_resolution_failed" };
  }

  const result = await sendEmail({
    db: svc,
    tenant: {
      id: tenant.id,
      legal_name: tenant.legal_name,
      mailing_address: tenant.mailing_address,
      // #1190: email send config comes from tenant_branding.
      email_send_pattern: branding.email_send_pattern ?? "platform_resend",
      tenant_resend_api_key_encrypted: branding.tenant_resend_api_key_encrypted,
      email_from_address: branding.email_from_address,
      email_from_name: branding.email_from_name,
    },
    to: user.email,
    subject,
    template_id: "task_reminder",
    category: "transactional",
    html,
    user_id: user.id,
    idempotencyKey: `task_reminder:${reminder_id}`,
  });

  if (result.status === "sent") return { status: "sent" };
  if (result.status === "suppressed" || result.status === "rate_limited") {
    return { status: "suppressed", reason: result.reason ?? result.status };
  }
  return { status: "failed", reason: result.reason ?? "email_send_failed" };
}
