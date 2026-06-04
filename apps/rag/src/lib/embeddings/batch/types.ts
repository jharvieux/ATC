// Issue #686 — Shared types for the OpenAI embedding batch pipeline.

export type PendingEmbeddingStatus = "pending" | "submitted" | "done" | "failed";

export interface PendingEmbeddingRow {
  id: string;
  chunk_id: string;
  content: string;
  custom_id: string;
  status: PendingEmbeddingStatus;
  batch_id: string | null;
  openai_file_id: string | null;
  output_file_id: string | null;
  error_detail: string | null;
  queued_at: string;
  submitted_at: string | null;
  completed_at: string | null;
}

// OpenAI Batch input line shape — JSONL, one per request.
export interface BatchInputLine {
  custom_id: string;
  method: "POST";
  url: "/v1/embeddings";
  body: {
    model: string;
    input: string;
    dimensions: number;
  };
}

// Subset of OpenAI Batch response we care about.
export interface OpenAIBatchSummary {
  id: string;
  status:
    | "validating"
    | "in_progress"
    | "finalizing"
    | "completed"
    | "expired"
    | "cancelling"
    | "cancelled"
    | "failed";
  output_file_id: string | null;
  error_file_id: string | null;
  errors: { data?: Array<{ message?: string }> } | null;
}

// One line of the output JSONL file.
export interface BatchOutputLine {
  id?: string;
  custom_id: string;
  response: {
    status_code: number;
    body: {
      data?: Array<{ embedding: number[]; index: number }>;
      model?: string;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    } | null;
  } | null;
  error: { code?: string; message?: string } | null;
}
