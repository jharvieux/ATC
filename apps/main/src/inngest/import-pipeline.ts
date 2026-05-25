// BP34 §34.3 — Import pipeline orchestrator.
//
// Each step is its own Inngest step.run so failures are retried at the
// step boundary, not the whole pipeline. State lives in import_queue;
// each transition updates `status` + writes the relevant column block.
//
// Virus scan is intentionally not in this pipeline — per user direction
// (2026-05-23) we rely on Gmail's scanning for the email path and skip
// file scanning on the document upload path until a real ClamAV daemon
// is wired. Items enter the pipeline at status='pending_classification'.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { classifyDocument } from "@/lib/import/classifier";
import { extractLeadNotification } from "@/lib/import/extractors/lead-notification";
import { extractBookingConfirmation } from "@/lib/import/extractors/booking-confirmation";
import { extractCommissionStatement } from "@/lib/import/extractors/commission-statement";
import { extractIntakeForm } from "@/lib/import/extractors/intake-form";
import { validate, type ValidationFlag, type ValidationInput } from "@/lib/import/validation";
import { decideRoute } from "@/lib/import/auto-accept";

type ImportQueueRow = {
  id: string;
  tenant_id: string;
  status: string;
  import_path: "email" | "document" | "manual";
  source_ref: string;
  raw_extracted_fields: unknown;
  // Text content lives on whichever upstream table the source_ref points to;
  // the orchestrator looks it up. For Phase B we read it out of a temporary
  // column on import_queue. Phase C wires real source tables.
  uploaded_file_path: string | null;
  document_type: string | null;
};

// Retention windows per §34.4 (in days). Applied at status transition.
const RETENTION_DAYS = {
  virus_detected: 30,
  parse_failed: 7,
  auto_accepted: 7,
  accepted: 7,
  rejected: 30,
} as const;

export const importPipeline = inngest.createFunction(
  {
    id: "import-pipeline",
    // Cap concurrency per tenant so a backfill from a single tenant doesn't
    // starve the others.
    concurrency: { key: "event.data.tenant_id", limit: 4 },
    retries: 3,
    triggers: [{ event: "import.queued" }],
  },
  async ({ event, step }) => {
    const { tenant_id, import_queue_id } = event.data;

    // Kill-switch — env var, not a feature flag table read, so disabling
    // it doesn't require a DB hop and works for every running instance.
    if (process.env.BP34_IMPORT_PIPELINE_DISABLED === "true") {
      return { skipped: true, reason: "BP34_IMPORT_PIPELINE_DISABLED=true" };
    }

    const svc = createServiceRoleClient();

    // ── 1. Load the queue row ───────────────────────────────────────────
    const row = await step.run("load-queue-row", async () => {
      const { data, error } = await svc
        .from("import_queue")
        .select("id, tenant_id, status, import_path, source_ref, raw_extracted_fields, uploaded_file_path, document_type")
        .eq("id", import_queue_id)
        .single();
      if (error) throw new Error(`load_queue_row_failed: ${error.message}`);
      if (!data) throw new Error("queue_row_not_found");
      const r = data as ImportQueueRow;
      if (r.tenant_id !== tenant_id) throw new Error("tenant_id_mismatch");
      return r;
    });

    // Guard: only process rows in the right state. Reprocessing accepted /
    // rejected items is a bug.
    if (row.status !== "pending_classification") {
      return { skipped: true, reason: `unexpected_status:${row.status}` };
    }

    // ── 2. Resolve raw text ─────────────────────────────────────────────
    const rawText = await step.run("resolve-text", () => resolveText(svc, row));
    if (!rawText) {
      await markParseFailed(svc, row.id, "no_text_available");
      return { failed: true, reason: "no_text_available" };
    }

    // ── 3. Classify ─────────────────────────────────────────────────────
    const classification = await step.run("classify", async () => {
      return classifyDocument({ tenant_id, text: rawText });
    });

    if (classification.error) {
      await markParseFailed(svc, row.id, `classify_error:${classification.error}`);
      return { failed: true, reason: classification.error };
    }

    await svc
      .from("import_queue")
      .update({
        status: "pending_extraction",
        document_type: classification.type,
        classification_confidence: classification.confidence,
      })
      .eq("id", row.id);

    if (classification.type === "unknown" || classification.route_to_review) {
      await routeToReview(svc, row.id, "low_classification_confidence_or_unknown_type");
      return { routed: "review", reason: "classification_uncertain" };
    }

    // ── 4. Extract ──────────────────────────────────────────────────────
    const extraction = await step.run("extract", async () => {
      return runExtractor(classification.type, { tenant_id, text: rawText });
    });

    if (extraction.error) {
      await markParseFailed(svc, row.id, `extract_error:${extraction.error}`);
      return { failed: true, reason: extraction.error };
    }

    await svc
      .from("import_queue")
      .update({
        status: "pending_validation",
        raw_extracted_fields: extraction.extracted,
        per_field_confidence: extraction.per_field_confidence,
        extraction_overall_confidence: extraction.overall_confidence,
      })
      .eq("id", row.id);

    // ── 5. Validate ─────────────────────────────────────────────────────
    const flags: ValidationFlag[] = await step.run("validate", async () => {
      return validate(buildValidationInput(classification.type, tenant_id, extraction.extracted), svc);
    });

    await svc
      .from("import_queue")
      .update({ validation_flags: flags })
      .eq("id", row.id);

    // ── 6. Route ────────────────────────────────────────────────────────
    const decision = await step.run("decide-route", async () => {
      return decideRoute({
        tenant_id,
        document_type: classification.type,
        overall_confidence: extraction.overall_confidence,
        validation_flags: flags,
        db: svc,
      });
    });

    if (decision.route === "review") {
      await routeToReview(svc, row.id, decision.reason);
      return { routed: "review", reason: decision.reason, threshold: decision.threshold_used };
    }

    // auto_accept — Phase C wires the promotion logic (write contact /
    // booking / commission rows). For Phase B we just mark the state.
    await svc
      .from("import_queue")
      .update({
        status: "auto_accepted",
        purgable_at: daysFromNow(RETENTION_DAYS.auto_accepted),
      })
      .eq("id", row.id);

    return { routed: "auto_accept", reason: decision.reason, threshold: decision.threshold_used };
  },
);

// ── helpers ──────────────────────────────────────────────────────────────

async function resolveText(svc: ReturnType<typeof createServiceRoleClient>, row: ImportQueueRow): Promise<string | null> {
  // Phase B: text lives wherever the source put it. Email path stores in
  // a sibling table keyed by source_ref; document path stores in
  // uploaded_file_path (we'd OCR/parse Phase C). Manual path stuffs the
  // body into source_ref directly.
  //
  // For Phase B we accept that document_path returns null (uploads aren't
  // wired yet) and that email_text comes from gmail_inbound_messages.
  if (row.import_path === "email") {
    const { data } = await svc
      .from("gmail_inbound_messages")
      .select("body_text")
      .eq("message_id", row.source_ref)
      .maybeSingle();
    return (data as { body_text?: string } | null)?.body_text ?? null;
  }
  if (row.import_path === "manual") {
    return row.source_ref; // entire payload IS the text
  }
  // document path: Phase C wires OCR/PDF parsing.
  return null;
}

async function markParseFailed(
  svc: ReturnType<typeof createServiceRoleClient>,
  id: string,
  reason: string,
): Promise<void> {
  await svc
    .from("import_queue")
    .update({
      status: "parse_failed",
      parse_failure_reason: reason,
      purgable_at: daysFromNow(RETENTION_DAYS.parse_failed),
    })
    .eq("id", id);
}

async function routeToReview(
  svc: ReturnType<typeof createServiceRoleClient>,
  id: string,
  reason: string,
): Promise<void> {
  // Review items don't get a purgable_at — they live until acted on. The
  // pending-review queue is the agent's responsibility.
  await svc
    .from("import_queue")
    .update({
      status: "pending_review",
      parse_failure_reason: null,
      validation_flags: undefined, // already written upstream; this is a no-op
    })
    .eq("id", id);
  // Log the reason for operator visibility — Phase C wires a proper
  // operator alert; for now console.warn lands in Vercel logs.
  console.warn(`[import-pipeline] queue=${id} routed to review: ${reason}`);
}

async function runExtractor(
  type: string,
  args: { tenant_id: string; text: string },
): Promise<{ extracted: unknown; per_field_confidence: Record<string, number>; overall_confidence: number; error?: string }> {
  switch (type) {
    case "lead_notification":
      return extractLeadNotification(args);
    case "booking_confirmation":
      return extractBookingConfirmation(args);
    case "commission_statement":
      return extractCommissionStatement(args);
    case "intake_form":
      return extractIntakeForm(args);
    default:
      return {
        extracted: null,
        per_field_confidence: {},
        overall_confidence: 0,
        error: `no_extractor_for_type:${type}`,
      };
  }
}

function buildValidationInput(
  type: string,
  tenant_id: string,
  fields: unknown,
): ValidationInput {
  // The extractor return shape is dispatched on `type` already, so we know
  // the field shape matches. Validators only read keys present on their
  // own shape; the cast is a boundary cast, not a logic claim.
  switch (type) {
    case "lead_notification":
    case "booking_confirmation":
    case "commission_statement":
    case "intake_form":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { type, tenant_id, fields: fields as any };
    default:
      throw new Error(`unknown_validation_type:${type}`);
  }
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}
