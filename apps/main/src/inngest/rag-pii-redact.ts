// §22.4 Stage 2 — PII redaction.
//
// Triggered by 'rag.submission_ready_for_pii_redaction'.
//
// Two passes:
//   1. Regex prefilter for zero-tolerance categories (SSN, credit card,
//      passport). On ANY match: status='quarantined', categories recorded,
//      pipeline HALTS, aggregation handler called to send/update alert.
//   2. Haiku redaction for tolerable categories (names, emails, phones).
//      §27.12 batch migration (F12): the synchronous Haiku call is now
//      ENQUEUED into the batch pipeline. The submission row stays at
//      pii_redaction_status='pending' between enqueue and consumer fire
//      (same posture as before the batch consumer landed — the UI
//      already shows "processing" for 'pending'). When the result lands,
//      `ragPiiRedactFromBatchResult` parses, writes status, and emits
//      'rag.submission_ready_for_normalization' to continue the
//      pipeline.

import { z } from "zod";
import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { detectZeroTolerancePII, type ZeroToleranceCategory } from "@/lib/rag-ingest/pii-regex-prefilter";
import { computeAggregation, type AggregationState } from "@/lib/rag-ingest/pii-quarantine-aggregator";
import { assertTenantStillPayingById } from "@/lib/billing/exclude-non-paying";
import { safeAwait } from "@/lib/db/safe-mutation";
import { enqueueBatchRequest } from "@/lib/ai/batch/enqueue";

const RagPiiCallerMetadataSchema = z.object({
  tenant_id: z.string(),
  submission_id: z.string(),
}).nullable();

const RagPiiBatchResultPayloadSchema = z.object({
  tenant_id: z.string(),
  result_text: z.string(),
  caller_metadata: RagPiiCallerMetadataSchema,
});

const RagPiiBatchFailurePayloadSchema = z.object({
  tenant_id: z.string(),
  error_detail: z.string(),
  caller_metadata: RagPiiCallerMetadataSchema,
});

const HAIKU_MODEL = process.env.RAG_INGEST_PII_REDACTION_HAIKU_MODEL ?? "claude-haiku-4-5-20251001";

const REDACTION_PROMPT = `You are a PII redaction filter. The user provides text from a travel
agency's knowledge base. Replace the following with [REDACTED]:
  - Personal names of customers (not company names, ship names, persona
    names, port names, or destinations)
  - Email addresses
  - Phone numbers (any format)

Preserve EVERYTHING ELSE exactly — formatting, line breaks, all other words,
URLs, prices, dates, ship names, port names. Do not summarize or rephrase.

Output ONLY the redacted text. No explanation, no JSON, no code fences.`;

export interface RedactSubmissionInput {
  db: ReturnType<typeof createServiceRoleClient>;
  tenant_id: string;
  submission_id: string;
}

export type RedactSubmissionResult =
  | { skipped: true; reason: string }
  | { ok: false; reason: string }
  | { ok: true; quarantined: true; categories: ZeroToleranceCategory[] }
  | { ok: true; enqueued: true; request_id: string };

// §22.4 Stage 2 core. Extracted from the Inngest handler so the zero-tolerance
// quarantine gate is unit-testable: zero-tolerance PII (SSN / credit card /
// passport) MUST quarantine and MUST NOT reach the Haiku enqueue. Empty content
// quarantines; clean content enqueues for tolerable-PII redaction.
export async function redactSubmission({
  db,
  tenant_id,
  submission_id,
}: RedactSubmissionInput): Promise<RedactSubmissionResult> {
  // §15.16 — Skip past-grace tenants.
  const paymentCheck = await assertTenantStillPayingById(db, tenant_id);
  if (!paymentCheck.ok) {
    console.info("[rag-pii-redact] skipping past-grace tenant", { tenant_id, submission_id, reason: paymentCheck.reason });
    return { skipped: true, reason: paymentCheck.reason ?? "past_grace" };
  }

  const { data: sub } = await db
    .from("rag_submissions")
    .select("extracted_content")
    .eq("id", submission_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();

  const row = sub as { extracted_content: string | null } | null;
  if (!row?.extracted_content) {
    await safeAwait(db
      .from("rag_submissions")
      .update({
        pii_redaction_status: "quarantined",
        quarantine_categories: ["empty_content"],
        updated_at: new Date().toISOString(),
      })
      .eq("id", submission_id), "rag_submissions.update");
    return { ok: false, reason: "no_extracted_content" };
  }

  const content = row.extracted_content;
  const regex = detectZeroTolerancePII(content);

  if (regex.detected) {
    await safeAwait(db
      .from("rag_submissions")
      .update({
        pii_redaction_status: "quarantined",
        quarantine_categories: regex.categories,
        updated_at: new Date().toISOString(),
      })
      .eq("id", submission_id), "rag_submissions.update");

    await runAggregationAndAlert(db, tenant_id, regex.categories, submission_id);
    return { ok: true, quarantined: true, categories: regex.categories };
  }

  // §27.12 — Enqueue Stage 2 (tolerable-PII Haiku redaction) into the
  // batch pipeline. The submission stays at pii_redaction_status='pending'
  // until the consumer (ragPiiRedactFromBatchResult) lands and writes
  // the final status.
  const { request_id } = await enqueueBatchRequest({
    tenant_id,
    purpose: "rag_pii_redaction",
    request_params: {
      model: HAIKU_MODEL,
      max_tokens: Math.max(1024, Math.min(content.length * 2, 16000)),
      system: REDACTION_PROMPT,
      messages: [{ role: "user", content }],
    },
    caller_metadata: {
      tenant_id,
      submission_id,
    },
    db,
  });

  console.info("[rag-pii-redact] enqueued submission=%s request=%s", submission_id, request_id);
  return { ok: true, enqueued: true, request_id };
}

export const ragPiiRedact = inngest.createFunction(
  {
    id: "rag-pii-redact",
    triggers: [{ event: "rag.submission_ready_for_pii_redaction" }],
  },
  async ({ event }) =>
    redactSubmission({
      db: createServiceRoleClient(),
      tenant_id: event.data.tenant_id as string,
      submission_id: event.data.submission_id as string,
    }),
);

// ── §27.12 batch consumer ────────────────────────────────────────────────────
//
// Fires when the reconciler completes a rag_pii_redaction batch row.
// Loads the submission for its current extracted_content, compares against
// the Haiku output to decide clean vs redacted, writes status, and emits
// 'rag.submission_ready_for_normalization' to keep the pipeline moving.

export interface ApplyRagPiiRedactInput {
  db: ReturnType<typeof createServiceRoleClient>;
  tenant_id: string;
  submission_id: string;
  result_text: string;
}

export type ApplyRagPiiRedactResult =
  | { status: "clean" }
  | { status: "redacted" }
  | { status: "quarantined"; reason: string };

export async function applyRagPiiRedactResult({
  db,
  tenant_id,
  submission_id,
  result_text,
}: ApplyRagPiiRedactInput): Promise<ApplyRagPiiRedactResult> {
  // Re-load the source content. The caller_metadata only carries IDs so
  // a long batch SLA doesn't leave us with a stale snapshot, and so a
  // concurrent operator edit doesn't get lost.
  const { data: sub } = await db
    .from("rag_submissions")
    .select("extracted_content")
    .eq("id", submission_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  const row = sub as { extracted_content: string | null } | null;
  if (!row?.extracted_content) {
    await safeAwait(db
      .from("rag_submissions")
      .update({
        pii_redaction_status: "quarantined",
        quarantine_categories: ["submission_missing_at_consumer"],
        updated_at: new Date().toISOString(),
      })
      .eq("id", submission_id), "rag_submissions.update");
    await runAggregationAndAlert(db, tenant_id, ["submission_missing_at_consumer"], submission_id);
    return { status: "quarantined", reason: "submission_missing_at_consumer" };
  }
  const extracted = row.extracted_content;

  // Fail-closed: empty Haiku output quarantines.
  if (result_text.length === 0) {
    await safeAwait(db
      .from("rag_submissions")
      .update({
        pii_redaction_status: "quarantined",
        quarantine_categories: ["haiku_empty_response"],
        updated_at: new Date().toISOString(),
      })
      .eq("id", submission_id), "rag_submissions.update");
    await runAggregationAndAlert(db, tenant_id, ["haiku_empty_response"], submission_id);
    return { status: "quarantined", reason: "haiku_empty_response" };
  }

  const status: "clean" | "redacted" = result_text !== extracted ? "redacted" : "clean";

  await safeAwait(db
    .from("rag_submissions")
    .update({
      pii_redaction_status: status,
      redacted_content: result_text,
      updated_at: new Date().toISOString(),
    })
    .eq("id", submission_id), "rag_submissions.update");

  await inngest.send({
    name: "rag.submission_ready_for_normalization",
    data: { submission_id, tenant_id },
  });

  return { status };
}

export const ragPiiRedactFromBatchResult = inngest.createFunction(
  {
    id: "rag-pii-redact-from-batch-result",
    triggers: [{ event: "ai.batch_request.completed.rag_pii_redaction" }],
  },
  async ({ event }) => {
    const parsed = RagPiiBatchResultPayloadSchema.safeParse(event.data);
    if (!parsed.success) {
      console.error("[rag-pii-redact:consumer] invalid event payload: %s", parsed.error.message);
      return { skipped: true, reason: "invalid_payload" };
    }
    const { tenant_id, result_text, caller_metadata } = parsed.data;
    if (!caller_metadata) {
      console.error("[rag-pii-redact:consumer] missing caller_metadata");
      return { error: "missing_caller_metadata" };
    }
    const { submission_id } = caller_metadata;
    const db = createServiceRoleClient();

    const outcome = await applyRagPiiRedactResult({
      db,
      tenant_id,
      submission_id,
      result_text,
    });
    return { submission_id, ...outcome };
  },
);

// Batch-failed sibling: when a row's batch errors at Anthropic (model error,
// expired, canceled), the reconciler emits ai.batch_request.failed.<purpose>.
// For PII redaction we quarantine — same posture as the pre-batch path on
// haikuPiiRedact returning status='failed'.
export const ragPiiRedactFromBatchFailure = inngest.createFunction(
  {
    id: "rag-pii-redact-from-batch-failure",
    triggers: [{ event: "ai.batch_request.failed.rag_pii_redaction" }],
  },
  async ({ event }) => {
    const parsed = RagPiiBatchFailurePayloadSchema.safeParse(event.data);
    if (!parsed.success) {
      console.error("[rag-pii-redact:failure] invalid event payload: %s", parsed.error.message);
      return { skipped: true, reason: "invalid_payload" };
    }
    const { tenant_id, error_detail, caller_metadata } = parsed.data;
    if (!caller_metadata) {
      console.error("[rag-pii-redact:failure] missing caller_metadata");
      return { error: "missing_caller_metadata" };
    }
    const { submission_id } = caller_metadata;
    const db = createServiceRoleClient();

    console.warn("[rag-pii-redact:failure] batch failed submission=%s: %s", submission_id, error_detail);
    await safeAwait(db
      .from("rag_submissions")
      .update({
        pii_redaction_status: "quarantined",
        quarantine_categories: ["haiku_redaction_failed"],
        updated_at: new Date().toISOString(),
      })
      .eq("id", submission_id), "rag_submissions.update");
    await runAggregationAndAlert(db, tenant_id, ["haiku_redaction_failed"], submission_id);
    return { submission_id, status: "quarantined", reason: error_detail };
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

  await safeAwait(db
    .from("tenants")
    .update({
      pii_quarantine_alert_window_start: decision.next.pii_quarantine_alert_window_start?.toISOString() ?? null,
      pii_quarantine_alert_count_in_window: decision.next.pii_quarantine_alert_count_in_window,
      pii_quarantine_recurring_days: decision.next.pii_quarantine_recurring_days,
      pii_quarantine_last_event_at: decision.next.pii_quarantine_last_event_at?.toISOString() ?? null,
    })
    .eq("id", tenant_id), "tenants.update");

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
