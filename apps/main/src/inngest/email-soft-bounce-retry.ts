// §23.7 — Soft bounce retry handler (#1611).
//
// Triggered by the Resend webhook on a soft bounce. Re-sends the stored rendered
// HTML at +6h / +12h / +24h (attempts 1-3); on the 4th consecutive failure the
// address is suppressed as a hard bounce. Delivery on any attempt terminates the
// chain early. All logic lives in lib/email/soft-bounce-retry.ts — this file is
// the thin Inngest wrapper supplying the durable step primitives.

import { z } from "zod";
import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { sendEmail } from "@/lib/email/send";
import { runSoftBounceRetryAttempt } from "@/lib/email/soft-bounce-retry";

const SoftBounceRetryPayloadSchema = z.object({
  email_log_id: z.string(),
  tenant_id: z.string(),
  attempt: z.number(),
});

export const emailSoftBounceRetry = inngest.createFunction(
  { id: "email-soft-bounce-retry", triggers: [{ event: "email/soft.bounce.retry" }] },
  async ({ event, step }) => {
    const parsed = SoftBounceRetryPayloadSchema.safeParse(event.data);
    if (!parsed.success) {
      console.error("[email-soft-bounce-retry] invalid event payload: %s", parsed.error.message);
      return { outcome: "invalid_payload" };
    }

    const db = createServiceRoleClient();
    const outcome = await runSoftBounceRetryAttempt(
      {
        db,
        sendEmail,
        sleep: (id, hours) => step.sleep(id, `${hours}h`),
        // step.run's real return type is Promise<Jsonify<T>> (the durable
        // boundary round-trips through JSON) — structurally compatible with our
        // plain-JSON EmailSendResult, but not nominally Promise<T>. Cast confined
        // to this one Inngest-coupled line; the pure lib stays Inngest-free.
        runStep: (id, fn) => step.run(id, fn) as unknown as ReturnType<typeof fn>,
        scheduleNext: (payload) =>
          inngest
            .send({
              // Deterministic id → a duplicate scheduleNext for the same attempt
              // (crash-resume re-running the post-claim work) is dropped by Inngest,
              // so the escalation chain can't compound. Distinct attempts carry
              // distinct ids, so legitimate progression is never deduped.
              id: `soft-retry:${payload.email_log_id}:attempt:${payload.attempt}`,
              name: "email/soft.bounce.retry",
              data: payload,
            })
            .then(() => undefined),
      },
      parsed.data,
    );

    console.info(
      `[email-soft-bounce-retry] log_id=${parsed.data.email_log_id} attempt=${parsed.data.attempt} outcome=${outcome}`,
    );
    return { outcome };
  },
);
