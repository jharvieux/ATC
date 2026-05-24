-- BP22 §6 — Configurable retrieval weights in match_knowledge_chunks.
--
-- 1. Seed the same four weight knobs into the rag-side platform_settings
--    replica so the RPC has a local source (mirrors the canonical values
--    in main; see migration 0006_platform_settings_replica.sql for the
--    cross-project resolution rationale).
-- 2. Recreate match_knowledge_chunks reading those four weights once at
--    the top of the function (single SELECT, not per-row) and applying:
--      composite = POWER(match, w_m) * POWER(authority, w_a) * POWER(recency, w_r)
--                + (w_f * feedback_factor)
--    Default 1.0 / 1.0 / 1.0 / 1.0 reproduces the pre-BP22 formula bit-for-bit.

INSERT INTO public.platform_settings (key, value, description) VALUES
  ('retrieval_weight_match',     '1.0'::JSONB, 'Exponent on match_score in composite_confidence. Default 1.0.'),
  ('retrieval_weight_authority', '1.0'::JSONB, 'Exponent on authority_score in composite_confidence. Default 1.0.'),
  ('retrieval_weight_recency',   '1.0'::JSONB, 'Exponent on recency_score in composite_confidence. Default 1.0.'),
  ('retrieval_weight_feedback',  '1.0'::JSONB, 'Multiplicative coefficient on feedback_factor. Default 1.0.')
ON CONFLICT (key) DO NOTHING;

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
SET search_path = ''
AS $$
DECLARE
  w_match     DOUBLE PRECISION;
  w_authority DOUBLE PRECISION;
  w_recency   DOUBLE PRECISION;
  w_feedback  DOUBLE PRECISION;
BEGIN
  -- Read the four weights once. Defaults guard against the row being absent.
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
    (kc.embedding <=> p_query_embedding)                                  AS cosine_distance,
    1.0 - (kc.embedding <=> p_query_embedding)                            AS match_score,
    COALESCE(kc.authority_manual_override, kc.authority_auto)::DOUBLE PRECISION AS authority_score,
    EXP(-EXTRACT(EPOCH FROM (NOW() - kc.ingested_at)) / 86400.0 / 90.0)  AS recency_score,
    public.compute_feedback_factor(kc.id)                                 AS feedback_factor,
    -- composite = match^w_m * authority^w_a * recency^w_r + w_f * feedback
    -- Defaults (1.0/1.0/1.0/1.0) reproduce the pre-BP22 formula exactly.
    (
      POWER(GREATEST(1.0 - (kc.embedding <=> p_query_embedding), 0.0), w_match)
      * POWER(GREATEST(COALESCE(kc.authority_manual_override, kc.authority_auto)::DOUBLE PRECISION, 0.0), w_authority)
      * POWER(GREATEST(EXP(-EXTRACT(EPOCH FROM (NOW() - kc.ingested_at)) / 86400.0 / 90.0), 0.0), w_recency)
    ) + (w_feedback * public.compute_feedback_factor(kc.id)::DOUBLE PRECISION) AS composite_confidence
  FROM public.knowledge_chunks kc
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
    AND (p_category     IS NULL OR kc.category                 = p_category)
    AND (p_cruise_line  IS NULL OR kc.cruise_line_or_supplier  = p_cruise_line)
    AND (p_ship         IS NULL OR kc.ship_or_property         = p_ship)
    AND (p_destination  IS NULL OR kc.destination              = p_destination)
    AND (p_agent_slug   IS NULL OR kc.agent_scope @> ARRAY[p_agent_slug])
    AND kc.status = 'approved'
    AND kc.superseded_by_chunk_id IS NULL
    AND kc.embedding IS NOT NULL
  ORDER BY composite_confidence DESC
  LIMIT p_top_k;
END;
$$;
