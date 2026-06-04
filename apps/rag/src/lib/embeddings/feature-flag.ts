// Issue #686 — Feature flag for routing embeddings through OpenAI Batch.
//
// Default is ENABLED (true). Set OPENAI_EMBEDDING_BATCH_ENABLED=false to fall
// back to synchronous embed() at ingest time. /api/retrieve never reads this
// flag — query embedding is on the chat critical path and stays synchronous
// regardless.

export function isEmbeddingBatchEnabled(): boolean {
  const raw = process.env.OPENAI_EMBEDDING_BATCH_ENABLED;
  if (raw === undefined || raw === "") return true;
  return raw.toLowerCase() !== "false" && raw !== "0";
}
