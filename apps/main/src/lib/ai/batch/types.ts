// §27.12 — Shared types for the AI batch pipeline.
//
// Kept separate from enqueue/flush/reconcile so consumers (Inngest
// functions that need the BatchablePurpose union, for example) can
// import without pulling the whole pipeline machinery.

/** Purposes that route through the batch pipeline. Subset of AICallPurpose. */
export type BatchablePurpose =
  | "precruise_generation"
  | "memory_extraction"
  | "persona_addendum_screen"
  | "persona_addendum_rescreen"
  | "rag_pii_redaction"
  | "rag_normalization";

export const BATCHABLE_PURPOSES: ReadonlySet<BatchablePurpose> = new Set([
  "precruise_generation",
  "memory_extraction",
  "persona_addendum_screen",
  "persona_addendum_rescreen",
  "rag_pii_redaction",
  "rag_normalization",
]);

/** Sent as the Inngest event when a batch request completes successfully. */
export interface BatchRequestCompletedPayload {
  request_id: string;
  tenant_id: string;
  purpose: BatchablePurpose;
  result_text: string;
  caller_metadata: Record<string, unknown> | null;
}

/** Sent when a single batch request fails (model error, expired, canceled). */
export interface BatchRequestFailedPayload {
  request_id: string;
  tenant_id: string;
  purpose: BatchablePurpose;
  error_detail: string;
  caller_metadata: Record<string, unknown> | null;
}
