-- Issue #686 — OpenAI Batch API embeddings.
--
-- pending_embedding queues chunks whose embedding hasn't been computed yet.
-- A flush cron collects pending rows, uploads a JSONL file to OpenAI, and
-- creates a batch. A reconcile cron polls the batch, downloads the output
-- file, and writes each result into knowledge_chunks.embedding.
--
-- Lifecycle:
--   pending   → row queued, awaiting next flush
--   submitted → flush bundled it into an OpenAI batch (batch_id stamped)
--   done      → reconcile wrote the embedding back to knowledge_chunks
--   failed    → terminal failure (model error / expired / canceled)
--
-- Service-role only. RLS enabled with zero policies = deny by default; only
-- the rag service's service-role connection bypasses RLS.

CREATE TABLE public.pending_embedding (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id        UUID        NOT NULL REFERENCES public.knowledge_chunks(id) ON DELETE CASCADE,
  content         TEXT        NOT NULL,
  custom_id       TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','submitted','done','failed')),
  batch_id        TEXT,
  openai_file_id  TEXT,
  output_file_id  TEXT,
  error_detail    TEXT,
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX pending_embedding_custom_id_idx
  ON public.pending_embedding(custom_id);

CREATE INDEX pending_embedding_status_queued_idx
  ON public.pending_embedding(status, queued_at);

CREATE INDEX pending_embedding_batch_id_idx
  ON public.pending_embedding(batch_id)
  WHERE batch_id IS NOT NULL;

ALTER TABLE public.pending_embedding ENABLE ROW LEVEL SECURITY;
-- No policies: service-role-only by design.
