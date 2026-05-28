-- §27.12 — Anthropic Message Batches API integration.
--
-- Two tables:
--   ai_batch_requests — one row per unit of work an Inngest producer
--                       wants to defer to a batch. Created by enqueue;
--                       completed (with result_text) or marked failed
--                       by the reconciler.
--   ai_batch_jobs     — one row per submitted Anthropic batch. Links
--                       N ai_batch_requests rows via batch_job_id.
--
-- Why two tables: a batch is the unit Anthropic sees (1 batch_id, 1
-- processing_status, 1 results blob); a request is the unit the
-- producer cares about (1 booking, 1 conversation, etc.). Joining
-- on batch_job_id lets us answer either question without denormalizing.
--
-- Cost attribution: each ai_batch_requests row carries tenant_id +
-- purpose, so when the reconciler parses results it can call
-- tenant_usage_metrics.ai_cost_cents per-row exactly the way
-- instrumentedClaudeCall does for direct calls.
--
-- RLS: service-role only. These tables are never read by user JWTs —
-- producers are Inngest functions, consumers are Inngest functions,
-- nothing customer-facing touches them.

CREATE TABLE IF NOT EXISTS public.ai_batch_jobs (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  anthropic_batch_id    TEXT         NOT NULL UNIQUE,
  purpose               TEXT         NOT NULL
                          CHECK (purpose IN (
                            'precruise_generation',
                            'memory_extraction',
                            'persona_addendum_screen',
                            'rag_pii_redaction',
                            'rag_normalization'
                          )),
  request_count         INTEGER      NOT NULL,
  status                TEXT         NOT NULL DEFAULT 'submitted'
                          CHECK (status IN ('submitted', 'processing', 'completed', 'failed', 'expired')),
  -- Last-known processing_status from Anthropic; recorded for
  -- observability when batches sit in intermediate states.
  anthropic_processing_status TEXT,
  total_input_tokens    BIGINT,
  total_output_tokens   BIGINT,
  -- Cost in cents across the whole batch — sum of per-row costs.
  -- Per-row attribution happens in ai_batch_requests via the
  -- existing tenant_usage_metrics increment path.
  total_cost_cents      BIGINT,
  submitted_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  reconciled_at         TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  failed_at             TIMESTAMPTZ,
  -- Error detail when status='failed' — usually a network or auth
  -- failure submitting the batch, not a per-row failure (those go
  -- on ai_batch_requests.error_detail instead).
  error_detail          TEXT
);

CREATE INDEX IF NOT EXISTS ai_batch_jobs_status_idx
  ON public.ai_batch_jobs (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS ai_batch_jobs_purpose_idx
  ON public.ai_batch_jobs (purpose, status);

CREATE TABLE IF NOT EXISTS public.ai_batch_requests (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  purpose             TEXT         NOT NULL
                        CHECK (purpose IN (
                          'precruise_generation',
                          'memory_extraction',
                          'persona_addendum_screen',
                          'rag_pii_redaction',
                          'rag_normalization'
                        )),
  status              TEXT         NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'submitted', 'completed', 'failed')),
  -- The custom_id we send to Anthropic in the batch request; lets us
  -- pair output rows back to ai_batch_requests rows on result parse.
  -- Format: <ai_batch_requests.id> (just the UUID, no prefix).
  custom_id           TEXT         NOT NULL UNIQUE,
  -- The full Anthropic message-create params (model, max_tokens,
  -- system, messages). Stored as JSONB so the reconciler can replay
  -- on partial-batch failure without re-running the producer's
  -- prompt-building logic.
  request_params      JSONB        NOT NULL,
  -- Producer-supplied context payload — booking_id, conversation_id,
  -- whatever the downstream consumer needs to do the side effect.
  -- Format is purpose-specific; consumer JSON-schemas its expected
  -- shape.
  caller_metadata     JSONB,
  -- Populated when status='completed' — the assistant's text output
  -- (joined from all text content blocks) and the structured usage
  -- metadata from Anthropic.
  result_text         TEXT,
  result_metadata     JSONB,
  -- Populated when status='failed' — per-row error from Anthropic
  -- (model refused, content policy, etc.) or from the reconciler
  -- (couldn't parse result row).
  error_detail        TEXT,
  -- Cost in cents for this specific row — written when results land
  -- so tenant_usage_metrics increments stay per-row accurate even
  -- though they happen in batch.
  cost_cents          BIGINT,
  batch_job_id        UUID         REFERENCES public.ai_batch_jobs(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  submitted_at        TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ai_batch_requests_pending_idx
  ON public.ai_batch_requests (purpose, status, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ai_batch_requests_batch_job_idx
  ON public.ai_batch_requests (batch_job_id);
CREATE INDEX IF NOT EXISTS ai_batch_requests_tenant_purpose_idx
  ON public.ai_batch_requests (tenant_id, purpose, created_at DESC);

-- RLS — service-role only. These tables are internal to the AI batch
-- pipeline; no user JWT path needs them.
ALTER TABLE public.ai_batch_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_batch_requests ENABLE ROW LEVEL SECURITY;

-- All four CRUD ops gated to service_role. The Supabase JS v2 service-
-- role client bypasses RLS but the table-level policy makes that
-- explicit for any future maintainer reading the schema.
CREATE POLICY ai_batch_jobs_service_role_all ON public.ai_batch_jobs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY ai_batch_requests_service_role_all ON public.ai_batch_requests
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_batch_jobs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_batch_requests TO service_role;

COMMENT ON TABLE public.ai_batch_jobs IS
  'One row per submitted Anthropic Message Batch. Status reflects our last reconciler poll, not real-time Anthropic state.';
COMMENT ON TABLE public.ai_batch_requests IS
  'One row per unit of work queued for batch processing. Consumers thread their downstream context via caller_metadata. Pair to Anthropic results via custom_id (= this table''s id).';
