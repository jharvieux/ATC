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
import { promoteImport } from "@/lib/import/promote";

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

// Retention windows per §34.4. Applied at status transition.
//   - virus_detected: 30d (§34.3.1)
//   - parse_failed:    7d (§34.4)
//   - accepted/rejected/auto_accepted: 24h (§34.4 — purge-parsed-documents
//     cron sweeps "extraction_status IN ('accepted','rejected') AND
//     extracted_at < NOW() - INTERVAL '24 hours'")
//   - pending_review: no fixed purge — retained until agent acts.
const RETENTION_HOURS = {
  virus_detected: 30 * 24,
  parse_failed: 7 * 24,
  auto_accepted: 24,
  accepted: 24,
  rejected: 24,
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

    // ── 3. Classify (or honor hint when caller pre-set document_type) ──
    let classification: { type: string; confidence: number; route_to_review: boolean; error?: string };
    if (row.document_type && row.document_type !== "unknown") {
      // Manual entry path passed a hint; trust it and skip the Haiku call.
      classification = { type: row.document_type, confidence: 1, route_to_review: false };
    } else {
      classification = await step.run("classify", async () => {
        return classifyDocument({ tenant_id, text: rawText });
      });
    }

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

    // auto_accept — call the shared promoter to write contact / booking /
    // commission rows. The promoter handles the §34.4 retention transition
    // (status='accepted' + 24h purgable_at). If commission_rate can't be
    // resolved, the promoter pushes the row back to pending_review with
    // reason='commission_rate_missing' (§34.7.3 step 3 fall-through).
    const promotion = await step.run("promote", () =>
      promoteImport({
        queue_row_id: row.id,
        svc,
        // Host-adapter rate lookup is not wired yet — when §13 publishes
        // a per-cruise-line rate API, pass it here. For now we fall
        // straight from doc-parsed → agent_set.
        getAdapterRate: undefined,
        acceptingUserId: null,
      }),
    );

    if (promotion.ok) {
      return {
        routed: "auto_accept",
        reason: decision.reason,
        threshold: decision.threshold_used,
        contact_id: promotion.contact_id,
        booking_id: promotion.booking_id,
      };
    }
    if ("needs_review" in promotion) {
      return { routed: "review", reason: promotion.reason, threshold: decision.threshold_used };
    }
    return { failed: true, reason: promotion.error };
  },
);

// ── helpers ──────────────────────────────────────────────────────────────

async function resolveText(svc: ReturnType<typeof createServiceRoleClient>, row: ImportQueueRow): Promise<string | null> {
  // Email path: read body_text from the gmail_inbound_messages row the
  // webhook persisted, keyed by Gmail message_id.
  if (row.import_path === "email") {
    const { data } = await svc
      .from("gmail_inbound_messages")
      .select("body_text")
      .eq("message_id", row.source_ref)
      .maybeSingle();
    return (data as { body_text?: string } | null)?.body_text ?? null;
  }
  // Manual path: the user-pasted body is in source_ref directly.
  if (row.import_path === "manual") {
    return row.source_ref;
  }
  // Document path: download the PDF from the imported-documents bucket
  // and run pdf-parse on it. text-only PDFs work fine; scanned-image
  // PDFs return empty (resolveText returns "") which the caller treats
  // as parse_failed (correct behavior — operator can re-submit as a
  // manual entry or via Gmail). OCR for scanned PDFs is a separate
  // capability we haven't shipped yet.
  if (row.import_path === "document" && row.uploaded_file_path) {
    try {
      const { data, error } = await svc.storage
        .from("imported-documents")
        .download(row.uploaded_file_path);
      if (error || !data) {
        console.warn(
          "[import-pipeline] storage download failed for %s: %s",
          row.id,
          error?.message ?? "no data",
        );
        return null;
      }
      const buf = Buffer.from(await data.arrayBuffer());
      // pdf-parse is dynamic-imported so the heavy module doesn't load
      // until the document path actually runs. pdf-parse v2 exposes a
      // PDFParse class; create one, getText() returns { text, pages }.
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: buf });
      let extracted = "";
      try {
        const result = await parser.getText();
        extracted = result.text ?? "";
      } finally {
        await parser.destroy();
      }
      const text = extracted.trim();
      if (!text) {
        console.info(
          "[import-pipeline] PDF parsed but text is empty (likely scanned/image-only) for %s",
          row.id,
        );
        return null;
      }
      return text;
    } catch (err) {
      console.warn(
        "[import-pipeline] pdf-parse threw for %s: %s",
        row.id,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }
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
      purgable_at: hoursFromNow(RETENTION_HOURS.parse_failed),
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
      return { type, tenant_id, fields } as ValidationInput;
    default:
      throw new Error(`unknown_validation_type:${type}`);
  }
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}
