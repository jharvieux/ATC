// Issue #686 — OpenAI Batch API helpers.
//
// Wraps the file-upload + batch-create flow and provides typed accessors for
// the four operations the flush/reconcile crons need.
//
// Kept separate from the synchronous `embed()` helper so that path stays a
// 12-line module — no cross-import. Tests stub the four exported functions
// directly.

import OpenAI from "openai";
import type { OpenAIBatchSummary } from "./types";

let _client: OpenAI | undefined;

export function getOpenAIClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

// Test seam — vitest overrides the client via the OpenAI library directly.
// The four functions below are also overridable via vi.spyOn(module, ...).

export async function uploadBatchInputFile(jsonl: string): Promise<string> {
  const client = getOpenAIClient();
  const file = await client.files.create({
    file: new File([jsonl], "embeddings-batch.jsonl", {
      type: "application/jsonl",
    }),
    purpose: "batch",
  });
  return file.id;
}

export async function createEmbeddingBatch(input_file_id: string): Promise<string> {
  const client = getOpenAIClient();
  const batch = await client.batches.create({
    input_file_id,
    endpoint: "/v1/embeddings",
    completion_window: "24h",
  });
  return batch.id;
}

export async function getBatchStatus(batch_id: string): Promise<OpenAIBatchSummary> {
  const client = getOpenAIClient();
  const batch = await client.batches.retrieve(batch_id);
  return {
    id: batch.id,
    status: batch.status as OpenAIBatchSummary["status"],
    output_file_id: batch.output_file_id ?? null,
    error_file_id: batch.error_file_id ?? null,
    errors: (batch.errors as OpenAIBatchSummary["errors"]) ?? null,
  };
}

export async function downloadBatchOutput(file_id: string): Promise<string> {
  const client = getOpenAIClient();
  const res = await client.files.content(file_id);
  return await res.text();
}
