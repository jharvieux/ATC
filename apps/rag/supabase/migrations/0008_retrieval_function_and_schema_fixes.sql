-- §8.4 / BP09: schema fixes and pgvector retrieval RPC
--
-- 1. knowledge_chunks.contact_id — promo override per §6.9 (include closed promo
--    chunks for a specific contact who still has an active deal).
-- 2. knowledge_ingestion_queue.submitted_by_user_id → nullable — service-to-service
--    ingest calls carry user_id = null in the JWT when there is no user session.
-- 3. match_knowledge_chunks() — pgvector retrieval RPC callable via Supabase JS
--    supabase.rpc('match_knowledge_chunks', {...}). Handles: scope filter, promo
--    filter, 4-score composite, and top-k ordering.

-- 1. Add contact_id to knowledge_chunks (promo override filter per §6.9)
ALTER TABLE public.knowledge_chunks
  ADD COLUMN IF NOT EXISTS contact_id UUID;

-- 2. Make submitted_by_user_id nullable (service-to-service ingest has no user session)
ALTER TABLE public.knowledge_ingestion_queue
  ALTER COLUMN submitted_by_user_id DROP NOT NULL;

-- 3. pgvector retrieval function
--
-- Scoring (§6 composite — equal weights pending §6 weighting spec TODO):
--   match_score  = 1 - cosine_distance          (vector similarity, in [0,1])
--   authority    = COALESCE(override, auto)      (in [0,1])
--   recency      = EXP(-days_since_ingested/90)  (exponential decay, half-life ≈ 90d)
--   feedback     = compute_feedback_factor(id)   (clamped adjustment per §6.10)
--
--   composite = (match_score * authority * recency) + feedback_factor
--
-- TODO(§6-weighting-formula): replace equal-weight formula when §6.X weighting spec is final.
--
-- Promo filter (§6.7 / §8.4):
--   Exclude chunks where expected_promo_state(...) IN ('closed_to_new','expired'),
--   UNLESS chunk.contact_id = p_include_closed_promo_contact_id (narrow override).
CREATE OR REPLACE FUNCTION public.match_knowledge_chunks(
  p_query_embedding        VECTOR(1536),
  p_tenant_id              UUID,
  p_top_k                  INTEGER,
  p_include_closed_promo_contact_id UUID DEFAULT NULL,
  p_category               TEXT DEFAULT NULL,
  p_cruise_line            TEXT DEFAULT NULL,
  p_ship                   TEXT DEFAULT NULL,
  p_destination            TEXT DEFAULT NULL,
  p_agent_slug             TEXT DEFAULT NULL
)
RETURNS TABLE (
  id                       UUID,
  content                  TEXT,
  content_hash             TEXT,
  scope                    TEXT,
  tenant_id                UUID,
  contact_id               UUID,
  category                 TEXT,
  cruise_line_or_supplier  TEXT,
  ship_or_property         TEXT,
  destination              TEXT,
  agent_scope              TEXT[],
  tags                     TEXT[],
  source_type              TEXT,
  source_url               TEXT,
  source_domain            TEXT,
  authority_auto           NUMERIC(3,2),
  authority_manual_override NUMERIC(3,2),
  ingested_at              TIMESTAMPTZ,
  expires_at               TIMESTAMPTZ,
  contains_pricing         BOOLEAN,
  sell_by_start_at         TIMESTAMPTZ,
  sell_by_at               TIMESTAMPTZ,
  sail_by_at               TIMESTAMPTZ,
  -- Scoring outputs
  cosine_distance          DOUBLE PRECISION,
  match_score              DOUBLE PRECISION,
  authority_score          DOUBLE PRECISION,
  recency_score            DOUBLE PRECISION,
  feedback_factor          NUMERIC,
  composite_confidence     DOUBLE PRECISION
)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.content,
    kc.content_hash,
    kc.scope,
    kc.tenant_id,
    kc.contact_id,
    kc.category,
    kc.cruise_line_or_supplier,
    kc.ship_or_property,
    kc.destination,
    kc.agent_scope,
    kc.tags,
    kc.source_type,
    kc.source_url,
    kc.source_domain,
    kc.authority_auto,
    kc.authority_manual_override,
    kc.ingested_at,
    kc.expires_at,
    kc.contains_pricing,
    kc.sell_by_start_at,
    kc.sell_by_at,
    kc.sail_by_at,
    -- Scoring
    (kc.embedding <=> p_query_embedding)                                  AS cosine_distance,
    1.0 - (kc.embedding <=> p_query_embedding)                            AS match_score,
    COALESCE(kc.authority_manual_override, kc.authority_auto)::DOUBLE PRECISION AS authority_score,
    EXP(-EXTRACT(EPOCH FROM (NOW() - kc.ingested_at)) / 86400.0 / 90.0)  AS recency_score,
    public.compute_feedback_factor(kc.id)                                 AS feedback_factor,
    -- composite = (match × authority × recency) + feedback
    -- TODO(§6-weighting-formula): replace when §6 weighting spec is finalised.
    (
      (1.0 - (kc.embedding <=> p_query_embedding))
      * COALESCE(kc.authority_manual_override, kc.authority_auto)::DOUBLE PRECISION
      * EXP(-EXTRACT(EPOCH FROM (NOW() - kc.ingested_at)) / 86400.0 / 90.0)
    ) + public.compute_feedback_factor(kc.id)::DOUBLE PRECISION           AS composite_confidence
  FROM public.knowledge_chunks kc
  WHERE
    -- Tenant scope filter (§6.9 / §8.9) — the ONLY allowed shape
    (kc.scope = 'global' OR (kc.scope = 'tenant' AND kc.tenant_id = p_tenant_id))

    -- Promo filter (§6.7 / §8.4)
    AND (
      kc.sell_by_at IS NULL  -- not a promo, never closed
      OR public.expected_promo_state(kc.sell_by_start_at, kc.sell_by_at, kc.sail_by_at)
           NOT IN ('closed_to_new', 'expired')
      OR (                   -- narrow override: contact still shopping a closed deal
        p_include_closed_promo_contact_id IS NOT NULL
        AND kc.contact_id = p_include_closed_promo_contact_id
      )
    )

    -- Optional category filters
    AND (p_category     IS NULL OR kc.category                 = p_category)
    AND (p_cruise_line  IS NULL OR kc.cruise_line_or_supplier  = p_cruise_line)
    AND (p_ship         IS NULL OR kc.ship_or_property         = p_ship)
    AND (p_destination  IS NULL OR kc.destination              = p_destination)
    AND (p_agent_slug   IS NULL OR kc.agent_scope @> ARRAY[p_agent_slug])

    -- Only approved, non-superseded chunks
    AND kc.status = 'approved'
    AND kc.superseded_by_chunk_id IS NULL

    -- Embedding must exist
    AND kc.embedding IS NOT NULL

  ORDER BY composite_confidence DESC
  LIMIT p_top_k;
END;
$$;
