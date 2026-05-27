// §22.4 Stage 2 — PII redaction.
//
// Triggered by 'rag.submission_ready_for_pii_redaction'.
//
// Two passes:
//   1. Regex prefilter for zero-tolerance categories (SSN, credit card,
//      passport). On ANY match: status='quarantined', categories recorded,
//      pipeline HALTS, aggregation handler called to send/update alert.
//   2. Haiku redaction for tolerable categories (names, emails, phones).
//      Result: 'clean' or 'redacted' with the [REDACTED]-marked content.
//
// On clean/redacted: emits 'rag.submission_ready_for_normalization'.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { detectZeroTolerancePII } from "@/lib/rag-ingest/pii-regex-prefilter";
import { haikuPiiRedact } from "@/lib/rag-ingest/haiku-pii-redact";
import { computeAggregation, type AggregationState } from "@/lib/rag-ingest/pii-quarantine-aggregator";
import { assertTenantStillPayingById } from "@/lib/billing/exclude-non-paying";

export const ragPiiRedact = inngest.createFunction(
  {
    id: "rag-pii-redact",
    triggers: [{ event: "rag.submission_ready_for_pii_redaction" }],
  },
  async ({ event }) => {
    const submission_id = event.data.submission_id as string;
    const tenant_id = event.data.tenant_id as string;
    const db = createServiceRoleClient();

    // §15.16 — Skip past-grace tenants (also short-circuits the haiku redact
    // call later in this function).
    const paymentCheck = await assertTenantStillPayingById(db, tenant_id);
    if (!paymentCheck.ok) {
      console.info("[rag-pii-redact] skipping past-grace tenant", { tenant_id, submission_id, reason: paymentCheck.reason });
      return { skipped: true, reason: paymentCheck.reason };
    }

    const { data: sub } = await db
      .from("rag_submissions")
      .select("extracted_content")
      .eq("id", submission_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();

    const row = sub as { extracted_content: string | null } | null;
    if (!row?.extracted_content) {
      await db
        .from("rag_submissions")
        .update({
          pii_redaction_status: "quarantined",
          quarantine_categories: ["empty_content"],
          updated_at: new Date().toISOString(),
        })
        .eq("id", submission_id);
      return { ok: false, reason: "no_extracted_content" };
    }

    const content = row.extracted_content;
    const regex = detectZeroTolerancePII(content);

    if (regex.detected) {
      await db
        .from("rag_submissions")
        .update({
          pii_redaction_status: "quarantined",
          quarantine_categories: regex.categories,
          updated_at: new Date().toISOString(),
        })
        .eq("id", submission_id);

      await runAggregationAndAlert(db, tenant_id, regex.categories, submission_id);
      return { ok: true, quarantined: true, categories: regex.categories };
    }

    // Haiku redaction for tolerable PII. D-091 Round-3 #44 — `failed` is
    // the fail-closed signal (missing key, vendor error, empty response).
    // Quarantine the submission and DO NOT promote to normalization.
    const redact = await haikuPiiRedact(content, { tenant_id });
    if (redact.status === "failed") {
      console.warn(
        `[rag-pii-redact] Haiku redaction failed, quarantining submission ${submission_id}: ${redact.reason}`,
      );
      await db
        .from("rag_submissions")
        .update({
          pii_redaction_status: "quarantined",
          quarantine_categories: ["haiku_redaction_failed"],
          updated_at: new Date().toISOString(),
        })
        .eq("id", submission_id);
      await runAggregationAndAlert(db, tenant_id, ["haiku_redaction_failed"], submission_id);
      return { ok: false, quarantined: true, reason: redact.reason };
    }

    await db
      .from("rag_submissions")
      .update({
        pii_redaction_status: redact.status,
        redacted_content: redact.content,
        updated_at: new Date().toISOString(),
      })
      .eq("id", submission_id);

    await inngest.send({
      name: "rag.submission_ready_for_normalization",
      data: { submission_id, tenant_id },
    });
    return { ok: true, redaction: redact.status };
  },
);

async function runAggregationAndAlert(
  db: ReturnType<typeof createServiceRoleClient>,
  tenant_id: string,
  categories: string[],
  submission_id: string,
): Promise<void> {
  const windowHours = Number(process.env.RAG_INGEST_AGGREGATION_WINDOW_HOURS ?? 24);
  const recurringDays = Number(process.env.RAG_INGEST_RECURRING_PATTERN_DAYS ?? 3);

  const { data: tenant } = await db
    .from("tenants")
    .select(
      "pii_quarantine_alert_window_start, pii_quarantine_alert_count_in_window, pii_quarantine_recurring_days, pii_quarantine_last_event_at",
    )
    .eq("id", tenant_id)
    .maybeSingle();

  const cur = tenant as {
    pii_quarantine_alert_window_start: string | null;
    pii_quarantine_alert_count_in_window: number;
    pii_quarantine_recurring_days: number;
    pii_quarantine_last_event_at: string | null;
  } | null;

  const current: AggregationState = {
    pii_quarantine_alert_window_start: cur?.pii_quarantine_alert_window_start
      ? new Date(cur.pii_quarantine_alert_window_start)
      : null,
    pii_quarantine_alert_count_in_window: cur?.pii_quarantine_alert_count_in_window ?? 0,
    pii_quarantine_recurring_days: cur?.pii_quarantine_recurring_days ?? 0,
    pii_quarantine_last_event_at: cur?.pii_quarantine_last_event_at
      ? new Date(cur.pii_quarantine_last_event_at)
      : null,
  };

  const decision = computeAggregation({
    current,
    now: new Date(),
    window_hours: windowHours,
    recurring_pattern_days: recurringDays,
  });

  await db
    .from("tenants")
    .update({
      pii_quarantine_alert_window_start: decision.next.pii_quarantine_alert_window_start?.toISOString() ?? null,
      pii_quarantine_alert_count_in_window: decision.next.pii_quarantine_alert_count_in_window,
      pii_quarantine_recurring_days: decision.next.pii_quarantine_recurring_days,
      pii_quarantine_last_event_at: decision.next.pii_quarantine_last_event_at?.toISOString() ?? null,
    })
    .eq("id", tenant_id);

  // TODO(bp23-email): swap to Resend send when the email pipeline lands in §23.
  // Until then log so operators see alerts in Inngest run output.
  if (decision.alert_action === "send_new") {
    console.warn(
      `[rag-pii-quarantine] NEW alert tenant=${tenant_id} categories=${categories.join(",")} submission=${submission_id} streak_days=${decision.next.pii_quarantine_recurring_days}`,
    );
  } else if (decision.alert_action === "update_existing") {
    console.warn(
      `[rag-pii-quarantine] UPDATE alert tenant=${tenant_id} count=${decision.next.pii_quarantine_alert_count_in_window} categories=${categories.join(",")}`,
    );
  }

  if (decision.emit_recurring_pattern_event) {
    // TODO(part-6 / BP27): abuse-signal subsystem consumes this event.
    await inngest.send({
      name: "tenant.rag_pii_recurring_pattern_detected",
      data: {
        tenant_id,
        recurring_days: decision.next.pii_quarantine_recurring_days,
        total_count_window: decision.next.pii_quarantine_alert_count_in_window,
      },
    });
  }
}
