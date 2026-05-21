-- §6.5: knowledge_ingestion_queue
-- §6.6: rag_retrieval_log

CREATE TABLE public.knowledge_ingestion_queue (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Submission
  raw_content           TEXT        NOT NULL,
  raw_source_url        TEXT,
  raw_source_type       TEXT        NOT NULL,
  raw_metadata          JSONB,
  submitted_by_user_id  UUID        NOT NULL,
  submitted_by_tenant_id UUID       NOT NULL,
  submitted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scope_intent          TEXT        NOT NULL DEFAULT 'tenant',
  priority              TEXT        NOT NULL DEFAULT 'normal',

  -- Normalization
  normalized_content            TEXT,
  ai_suggested_category         TEXT,
  ai_suggested_cruise_line      TEXT,
  ai_suggested_ship             TEXT,
  ai_suggested_destination      TEXT,
  ai_summary                    TEXT,
  ai_quality_score              NUMERIC(3,2),
  ai_authority_score            NUMERIC(3,2),
  ai_relevance_score_global     NUMERIC(3,2),
  ai_pricing_detected           BOOLEAN,
  ai_promo_detection            JSONB,

  -- Review
  edited_content                TEXT,
  edited_category               TEXT,
  edited_authority_override     NUMERIC(3,2),
  edited_authority_override_reason TEXT,
  edited_expires_at             TIMESTAMPTZ,
  tenant_reviewed_by_user_id    UUID,
  tenant_reviewed_at            TIMESTAMPTZ,

  -- Global review (per §22 revised model)
  global_review_status          TEXT,
  global_submitted_at           TIMESTAMPTZ,
  global_reviewed_by_user_id    UUID,
  global_reviewed_at            TIMESTAMPTZ,
  auto_flagged_for_global       BOOLEAN     NOT NULL DEFAULT FALSE,
  tenant_global_promotion_objection BOOLEAN NOT NULL DEFAULT FALSE,
  tenant_objection_reason       TEXT,

  -- Promotion
  promoted_to_chunk_id          UUID        REFERENCES public.knowledge_chunks(id),
  promoted_at                   TIMESTAMPTZ,
  promotion_scope               TEXT,

  -- Stage
  processing_stage              TEXT        NOT NULL DEFAULT 'submitted',
  failure_reason                TEXT
);

-- §6.6: rag_retrieval_log
-- Retention: 90 days detail then aggregated (§6.12).
CREATE TABLE public.rag_retrieval_log (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID        NOT NULL,
  user_id               UUID,
  conversation_id       UUID,
  persona_id            UUID,
  query_text            TEXT,
  filters_applied       JSONB,
  chunks_returned       JSONB,
  top_k_requested       INTEGER,
  retrieval_latency_ms  INTEGER,
  outcome               TEXT,
  outcome_signal_source TEXT,
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX rag_retrieval_log_tenant_idx
  ON public.rag_retrieval_log(tenant_id, occurred_at DESC);
