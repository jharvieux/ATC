-- Issue #689 — Embedding-cost telemetry for the platform admin Resource
-- Utilization dashboard.
--
-- Two changes:
--
-- 1. rag_ai_call_log — per-call OpenAI embedding cost log. Mirrors the column
--    shape of the main app's ai_call_log so the dashboard can merge rows
--    without translation. tenant_id is NULLABLE here (platform-admin
--    ingests are NOT tenant-attributable) — that's the only column-shape
--    difference from the main app's table. No FK to a tenants table; rag
--    has tenant_registry_shadow instead of tenants, and platform ingests
--    have no tenant to point at.
--
-- 2. ALTER pending_embedding ADD COLUMN tenant_id UUID NULL — the
--    reconciler reads this to attribute embedding cost on completion.
--    Backfill: existing rows (if any from PR #688 between merges) get NULL
--    and will be billed as platform overhead, which matches the assumption
--    those tests/early enqueues were platform-driven.

-- 1. rag_ai_call_log

CREATE TABLE public.rag_ai_call_log (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID,
  model               TEXT        NOT NULL,
  vendor              TEXT        NOT NULL CHECK (vendor IN ('openai')),
  purpose             TEXT        NOT NULL DEFAULT 'embedding'
                                  CHECK (purpose IN ('embedding')),
  source              TEXT        NOT NULL CHECK (source IN ('sync','batch')),
  input_tokens        INTEGER     NOT NULL,
  output_tokens       INTEGER     NOT NULL DEFAULT 0,
  cost_estimate_cents BIGINT      NOT NULL,
  latency_ms          INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX rag_ai_call_log_tenant_recent_idx
  ON public.rag_ai_call_log(tenant_id, created_at DESC)
  WHERE tenant_id IS NOT NULL;
CREATE INDEX rag_ai_call_log_created_idx
  ON public.rag_ai_call_log(created_at);
CREATE INDEX rag_ai_call_log_source_idx
  ON public.rag_ai_call_log(source, created_at DESC);

ALTER TABLE public.rag_ai_call_log ENABLE ROW LEVEL SECURITY;
-- No policies = service-role only.

-- 2. pending_embedding.tenant_id

ALTER TABLE public.pending_embedding
  ADD COLUMN tenant_id UUID;

CREATE INDEX pending_embedding_tenant_idx
  ON public.pending_embedding(tenant_id)
  WHERE tenant_id IS NOT NULL;
