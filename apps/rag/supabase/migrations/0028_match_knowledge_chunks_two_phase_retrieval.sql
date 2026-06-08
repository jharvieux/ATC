-- Performance: match_knowledge_chunks two-phase ANN + re-rank.
--
-- Root cause of 32-second query time:
--   compute_feedback_factor() does 5 DB queries per call (4× platform_settings
--   reads + 1× feedback events scan). The function is called twice per row
--   across all ~28K approved chunks, producing ~280K sub-queries before the
--   ORDER BY composite_confidence LIMIT can be applied. The IVFFlat index can
--   only accelerate ORDER BY embedding <=> p LIMIT N — the composite re-ranking
--   defeats it, forcing a full sequential scan.
--
-- Fix: two-phase CTE.
--   Phase 1 (ann): simple ORDER BY embedding <=> p LIMIT N — IVFFlat index is
--     used, returns top GREATEST(p_top_k * 20, 200) candidates by cosine distance.
--     Cosine distance is computed once and carried forward.
--   Phase 2 (outer): join back to knowledge_chunks for full row data, apply all
--     business-logic filters (scope, promo, category…), compute composite score
--     and call compute_feedback_factor only for the ~200 candidates.
--
-- Expected improvement: 32 s → < 500 ms.

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
  cosine_distance          DOUBLE PRECISION,
  match_score              DOUBLE PRECISION,
  authority_score          DOUBLE PRECISION,
  recency_score            DOUBLE PRECISION,
  feedback_factor          NUMERIC,
  composite_confidence     DOUBLE PRECISION
)
LANGUAGE plpgsql
STABLE
SET search_path = 'public'
AS $$
DECLARE
  w_match     DOUBLE PRECISION;
  w_authority DOUBLE PRECISION;
  w_recency   DOUBLE PRECISION;
  w_feedback  DOUBLE PRECISION;
BEGIN
  SELECT COALESCE((value)::DOUBLE PRECISION, 1.0) INTO w_match
    FROM public.platform_settings WHERE key = 'retrieval_weight_match';
  SELECT COALESCE((value)::DOUBLE PRECISION, 1.0) INTO w_authority
    FROM public.platform_settings WHERE key = 'retrieval_weight_authority';
  SELECT COALESCE((value)::DOUBLE PRECISION, 1.0) INTO w_recency
    FROM public.platform_settings WHERE key = 'retrieval_weight_recency';
  SELECT COALESCE((value)::DOUBLE PRECISION, 1.0) INTO w_feedback
    FROM public.platform_settings WHERE key = 'retrieval_weight_feedback';

  w_match     := COALESCE(w_match,     1.0);
  w_authority := COALESCE(w_authority, 1.0);
  w_recency   := COALESCE(w_recency,   1.0);
  w_feedback  := COALESCE(w_feedback,  1.0);

  RETURN QUERY
  WITH ann AS (
    -- Phase 1: IVFFlat ANN — ORDER BY <=> LIMIT uses the vector index.
    -- Over-fetch so business-logic filters in phase 2 don't under-deliver.
    -- Compute cosine distance once here and carry it forward.
    SELECT
      kc.id                                  AS ann_id,
      (kc.embedding <=> p_query_embedding)   AS cosine_dist
    FROM public.knowledge_chunks kc
    WHERE kc.status             = 'approved'
      AND kc.embedding          IS NOT NULL
      AND kc.superseded_by_chunk_id IS NULL
    ORDER BY kc.embedding <=> p_query_embedding
    LIMIT GREATEST(p_top_k * 20, 200)
  )
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
    ann.cosine_dist::DOUBLE PRECISION                                           AS cosine_distance,
    (1.0 - ann.cosine_dist)::DOUBLE PRECISION                                  AS match_score,
    COALESCE(kc.authority_manual_override, kc.authority_auto)::DOUBLE PRECISION AS authority_score,
    EXP((-EXTRACT(EPOCH FROM (NOW() - kc.ingested_at)))::DOUBLE PRECISION / 86400.0 / 90.0) AS recency_score,
    -- Gate: skip the 5-query feedback function when the pre-computed signal
    -- count is 0. With an empty feedback table this eliminates ~400 sub-queries.
    CASE WHEN kc.feedback_signal_count > 0
         THEN public.compute_feedback_factor(kc.id)
         ELSE 0::NUMERIC
    END                                                                         AS feedback_factor,
    (
      POWER(GREATEST((1.0 - ann.cosine_dist)::DOUBLE PRECISION, 0.0), w_match)
      * POWER(GREATEST(COALESCE(kc.authority_manual_override, kc.authority_auto)::DOUBLE PRECISION, 0.0), w_authority)
      * POWER(GREATEST(EXP((-EXTRACT(EPOCH FROM (NOW() - kc.ingested_at)))::DOUBLE PRECISION / 86400.0 / 90.0), 0.0), w_recency)
    ) + (w_feedback * CASE WHEN kc.feedback_signal_count > 0
                           THEN public.compute_feedback_factor(kc.id)::DOUBLE PRECISION
                           ELSE 0::DOUBLE PRECISION
                      END)                                                      AS composite_confidence
  FROM public.knowledge_chunks kc
  JOIN ann ON ann.ann_id = kc.id
  WHERE
    (kc.scope = 'global' OR (kc.scope = 'tenant' AND kc.tenant_id = p_tenant_id))
    AND (
      kc.sell_by_at IS NULL
      OR public.expected_promo_state(kc.sell_by_start_at, kc.sell_by_at, kc.sail_by_at)
           NOT IN ('closed_to_new', 'expired')
      OR (
        p_include_closed_promo_contact_id IS NOT NULL
        AND kc.contact_id = p_include_closed_promo_contact_id
      )
    )
    AND (p_category     IS NULL OR kc.category                = p_category)
    AND (p_cruise_line  IS NULL OR kc.cruise_line_or_supplier = p_cruise_line)
    AND (p_ship         IS NULL OR kc.ship_or_property        = p_ship)
    AND (p_destination  IS NULL OR kc.destination             = p_destination)
    AND (p_agent_slug   IS NULL OR kc.agent_scope @> ARRAY[p_agent_slug])
  ORDER BY composite_confidence DESC
  LIMIT p_top_k;
END;
$$;
