// §22.4 Stage 1 — File content extraction.
//
// Triggered by 'rag.submission_needs_extraction'. Reads the file from
// Supabase Storage and dispatches to the appropriate parser by MIME type.
// On success: writes extracted_content + extraction_status='extracted' and
// emits 'rag.submission_ready_for_pii_redaction'. On parser-unavailable or
// failure: writes extraction_status='failed' with error and surfaces to the
// submitter via the tenant review queue (status stays out of ready_for_review).

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { extractContent } from "@/lib/rag-ingest/extract-content";
import { assertTenantStillPayingById } from "@/lib/billing/exclude-non-paying";
import { safeAwait } from "@/lib/db/safe-mutation";

export const ragExtractContent = inngest.createFunction(
  {
    id: "rag-extract-content",
    triggers: [{ event: "rag.submission_needs_extraction" }],
  },
  async ({ event }) => {
    const submission_id = event.data.submission_id as string;
    const tenant_id = event.data.tenant_id as string;
    const db = createServiceRoleClient();

    // §15.16 — Skip past-grace tenants. Extract is the first step of the
    // ingest pipeline; gating here also short-circuits the downstream
    // normalize/pii-redact steps.
    const paymentCheck = await assertTenantStillPayingById(db, tenant_id);
    if (!paymentCheck.ok) {
      console.info("[rag-extract-content] skipping past-grace tenant", { tenant_id, submission_id, reason: paymentCheck.reason });
      return { ok: false, reason: paymentCheck.reason ?? "past_grace" };
    }

    const { data: sub, error } = await db
      .from("rag_submissions")
      .select("original_file_path, original_file_mime_type")
      .eq("id", submission_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();

    if (error || !sub) {
      return { ok: false, reason: "submission_not_found" };
    }

    const row = sub as { original_file_path: string | null; original_file_mime_type: string | null };
    if (!row.original_file_path || !row.original_file_mime_type) {
      await safeAwait(db
        .from("rag_submissions")
        .update({
          extraction_status: "failed",
          extraction_error: "missing_file_path_or_mime",
          updated_at: new Date().toISOString(),
        })
        .eq("id", submission_id), "rag_submissions.update");
      return { ok: false, reason: "missing_file_inputs" };
    }

    await safeAwait(db
      .from("rag_submissions")
      .update({ extraction_status: "extracting", updated_at: new Date().toISOString() })
      .eq("id", submission_id), "rag_submissions.update");

    const result = await extractContent({
      db,
      storage_path: row.original_file_path,
      mime_type: row.original_file_mime_type,
    });

    if (result.status === "extracted" && result.content) {
      await safeAwait(db
        .from("rag_submissions")
        .update({
          extraction_status: "extracted",
          extracted_content: result.content,
          updated_at: new Date().toISOString(),
        })
        .eq("id", submission_id), "rag_submissions.update");
      await inngest.send({
        name: "rag.submission_ready_for_pii_redaction",
        data: { submission_id, tenant_id },
      });
      return { ok: true };
    }

    // Failed or unavailable: log the reason on the row.
    await safeAwait(db
      .from("rag_submissions")
      .update({
        extraction_status: "failed",
        extraction_error: result.error ?? "unknown",
        updated_at: new Date().toISOString(),
      })
      .eq("id", submission_id), "rag_submissions.update");
    return { ok: false, reason: result.error ?? "extraction_failed" };
  },
);
