-- §6.4: knowledge_chunks
--
-- RLS note: The RAG service uses service-role exclusively for all reads and
-- writes. Tenant isolation is enforced in application code via the scope filter:
--   WHERE scope = 'global' OR (scope = 'tenant' AND tenant_id = caller_tenant_id)
-- per §6.9. Row-level security at the DB layer is therefore not required here.
-- See apps/rag/db/rls-snapshot.sql for the exception record.

CREATE TABLE public.knowledge_chunks (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  content                 TEXT        NOT NULL,
  content_hash            TEXT        NOT NULL,
  token_count             INTEGER,
  embedding               VECTOR(1536),

  -- Scope
  scope                   TEXT        NOT NULL CHECK (scope IN ('global','tenant')),
  tenant_id               UUID        REFERENCES public.tenant_registry(tenant_id),

  -- Categorization
  category                TEXT        NOT NULL,
  cruise_line_or_supplier TEXT,
  ship_or_property        TEXT,
  destination             TEXT,
  agent_scope             TEXT[],
  tags                    TEXT[],

  -- Source
  source_type             TEXT        NOT NULL,
  source_url              TEXT,
  source_domain           TEXT,

  -- Authority (§6.3)
  authority_auto          NUMERIC(3,2) NOT NULL,
  authority_manual_override NUMERIC(3,2),
  authority_override_reason TEXT,

  -- Lifecycle
  ingested_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at              TIMESTAMPTZ,
  superseded_by_chunk_id  UUID        REFERENCES public.knowledge_chunks(id),

  -- Special flags
  contains_pricing        BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Promo lifecycle (§6.7) — stored dates from spec §6.4
  promo_sell_by_date      DATE,
  promo_sail_by_date      DATE,
  promo_status            TEXT,

  -- Promo lifecycle — TIMESTAMPTZ columns required by expected_promo_state() (§6.7)
  -- sell_by_start_at: promo not yet open to new bookings before this point
  -- sell_by_at: deadline for new bookings; promo becomes closed_to_new after this
  -- sail_by_at: last eligible sailing; promo becomes expired after this
  promo_status_reconciled_at TIMESTAMPTZ,
  sell_by_start_at        TIMESTAMPTZ,
  sell_by_at              TIMESTAMPTZ,
  sail_by_at              TIMESTAMPTZ,

  -- Status
  status                  TEXT        NOT NULL DEFAULT 'approved',
  ingested_by_user_id     UUID,
  approved_by_user_id     UUID,
  approved_at             TIMESTAMPTZ
);

-- HNSW/ivfflat vector similarity index (cosine distance per §8.4)
CREATE INDEX knowledge_chunks_embedding_idx
  ON public.knowledge_chunks USING ivfflat (embedding vector_cosine_ops);

-- Scope + tenant lookup (primary query path per §6.9)
CREATE INDEX knowledge_chunks_scope_tenant_idx
  ON public.knowledge_chunks(scope, tenant_id);

-- Category filter
CREATE INDEX knowledge_chunks_category_idx
  ON public.knowledge_chunks(category);
