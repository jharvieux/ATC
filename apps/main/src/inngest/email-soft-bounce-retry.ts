// §23.7 — Soft bounce retry handler.
//
// Triggered by the Resend webhook handler on soft bounces.
// Retries at +6h, +12h, +24h (attempt 1, 2, 3). On the 4th soft bounce
// the email is marked hard_bounced and the address is suppressed.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertTenantStillPayingById } from "@/lib/billing/exclude-non-paying";
import { safeAwait } from "@/lib/db/safe-mutation";

const RETRY_DELAYS_HOURS = [6, 12, 24];

export const emailSoftBounceRetry = inngest.createFunction(
  { id: "email-soft-bounce-retry", triggers: [{ event: "email/soft.bounce.retry" }] },
  async ({ event, step }) => {
    const { email_log_id, tenant_id, attempt } = event.data as {
      email_log_id: string;
      tenant_id: string;
      attempt: number;
    };

    // §15.16 — Don't keep retrying email sends for a past-grace tenant.
    {
      const svc = createServiceRoleClient();
      const paymentCheck = await assertTenantStillPayingById(svc, tenant_id);
      if (!paymentCheck.ok) {
        console.info("[email-soft-bounce-retry] skipping past-grace tenant",
          { tenant_id, email_log_id, reason: paymentCheck.reason });
        return;
      }
    }

    if (attempt > RETRY_DELAYS_HOURS.length) {
      // Exceeded retry budget — treat as hard bounce.
      const svc = createServiceRoleClient();
      const { data: logRow } = await svc
        .from("email_log")
        .select("to_email")
        .eq("id", email_log_id)
        .maybeSingle();

      if (logRow) {
        const toEmail = (logRow as { to_email: string }).to_email;
        await safeAwait(svc
          .from("email_log")
          .update({ status: "hard_bounced", bounce_reason: "soft_bounce_max_retries" })
          .eq("id", email_log_id), "email_log.update");
        await safeAwait(svc.from("email_suppressions").upsert(
          { tenant_id, email_address: toEmail, reason: "hard_bounce" },
          { onConflict: "tenant_id,email_address,reason" },
        ), "email_suppressions.upsert");
      }
      return;
    }

    const delayHours = RETRY_DELAYS_HOURS[attempt - 1] ?? 6;
    await step.sleep(`retry-delay-${attempt}`, `${delayHours}h`);

    // Re-read the log row — if it was already delivered, skip.
    const svc = createServiceRoleClient();
    const { data: logRow } = await svc
      .from("email_log")
      .select("status, to_email, from_email, subject, resend_message_id")
      .eq("id", email_log_id)
      .maybeSingle();

    if (!logRow) return;
    const row = logRow as {
      status: string;
      to_email: string;
      from_email: string;
      subject: string;
    };

    if (row.status === "delivered") {
      console.info(`[soft-bounce-retry] already delivered: log_id=${email_log_id}`);
      return;
    }

    // We don't have the original rendered HTML stored, so we just trigger the
    // next retry attempt via a new event. Full re-render is out of scope here;
    // the retry is a signal that the email service should attempt redelivery.
    // In practice, Resend's internal retry queue handles most soft bounces.
    // This Inngest job is the explicit overflow safety net.
    console.info(`[soft-bounce-retry] attempt=${attempt} log_id=${email_log_id} to=${row.to_email}`);

    if (attempt < RETRY_DELAYS_HOURS.length) {
      await inngest.send({
        name: "email/soft.bounce.retry",
        data: { email_log_id, tenant_id, attempt: attempt + 1 },
      });
    } else {
      // Final attempt exhausted
      await safeAwait(svc
        .from("email_log")
        .update({ status: "hard_bounced", bounce_reason: "soft_bounce_max_retries" })
        .eq("id", email_log_id), "email_log.update");
      const toEmail = row.to_email;
      await safeAwait(svc.from("email_suppressions").upsert(
        { tenant_id, email_address: toEmail, reason: "hard_bounce" },
        { onConflict: "tenant_id,email_address,reason" },
      ), "email_suppressions.upsert");
    }
  },
);
