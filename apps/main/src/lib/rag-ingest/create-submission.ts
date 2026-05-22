// §22 — Shared helper for creating a rag_submissions row + triggering the
// pipeline. Every submission method funnels through here so the four-stage
// pipeline (extract → PII redact → normalize → review) starts at a single
// well-typed boundary.
//
// Inngest event dispatched:
//   - If original_file_path provided → 'rag.submission_needs_extraction'
//     (Stage 1 will run the file parser dispatch)
//   - Otherwise (text content) → 'rag.submission_ready_for_pii_redaction'
//     (text is its own "extracted_content"; Stage 1 is a no-op)

import type { SupabaseClient } from "@supabase/supabase-js";
import { inngest } from "@/inngest/client";

export type SubmissionMethod =
  | "web_ui"
  | "browser_extension"
  | "ios_shortcut"
  | "file_upload"
  | "manual_entry"
  | "batch_api";

export interface CreateSubmissionInput {
  db: SupabaseClient;
  tenant_id: string;
  submitted_by_user_id: string;
  submission_method: SubmissionMethod;
  source_url?: string | null;
  source_title?: string | null;
  original_content?: string | null;
  original_file_path?: string | null;
  original_file_mime_type?: string | null;
}

export interface CreateSubmissionResult {
  submission_id: string;
  status: "pending" | "extracting" | "extracted";
}

export async function createSubmission(
  input: CreateSubmissionInput,
): Promise<CreateSubmissionResult> {
  if (!input.original_content && !input.original_file_path) {
    throw new Error("createSubmission requires original_content or original_file_path");
  }

  // Text path: skip Stage 1; extracted_content := original_content.
  const isFile = !!input.original_file_path;
  const insertPayload: Record<string, unknown> = {
    tenant_id: input.tenant_id,
    submitted_by_user_id: input.submitted_by_user_id,
    submission_method: input.submission_method,
    source_url: input.source_url ?? null,
    source_title: input.source_title ?? null,
    original_content: input.original_content ?? null,
    original_file_path: input.original_file_path ?? null,
    original_file_mime_type: input.original_file_mime_type ?? null,
  };
  if (isFile) {
    insertPayload.extraction_status = "pending";
  } else {
    insertPayload.extraction_status = "extracted";
    insertPayload.extracted_content = input.original_content;
  }

  const { data, error } = await input.db
    .from("rag_submissions")
    .insert(insertPayload)
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`rag_submissions insert failed: ${error?.message ?? "unknown"}`);
  }

  const submission_id = (data as { id: string }).id;

  if (isFile) {
    await inngest.send({
      name: "rag.submission_needs_extraction",
      data: { submission_id, tenant_id: input.tenant_id },
    });
    return { submission_id, status: "pending" };
  }

  await inngest.send({
    name: "rag.submission_ready_for_pii_redaction",
    data: { submission_id, tenant_id: input.tenant_id },
  });
  return { submission_id, status: "extracted" };
}
