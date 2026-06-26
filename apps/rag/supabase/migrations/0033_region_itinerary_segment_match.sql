-- 0033 — segment-exact port matching in match_region_itinerary_chunks (#1466).
--
-- 0031/0032 matched port tokens with substring ILIKE ('%Sydney%'). City names
-- collide across countries under substring containment: "Sydney" (Australia) is
-- a substring of "Sydney NS, Nova Scotia Canada", so an Australia query bled in
-- ~173 Canadian Maritime sailings. Bare-vs-suffixed forms (departure_port is a
-- bare "Sydney" for 406 Australian sailings) meant the token couldn't simply be
-- narrowed to "Sydney, NSW" without dropping those departures.
--
-- Fix: match PORT tokens against the comma/hyphen-delimited SEGMENTS of the port
-- string, requiring case-insensitive EQUALITY to a segment rather than substring
-- containment. CruiseMapper port strings are segmented like
-- "Sydney, NSW Australia" / "Sydney NS, Nova Scotia Canada" / "Civitavecchia-Rome",
-- so:
--   - "Sydney"  matches segment "Sydney"  (AU bare + "Sydney, NSW Australia")
--               but NOT "Sydney NS"        (Canada) — bleed eliminated.
--   - "Rome"    matches segment "Rome" of "Civitavecchia-Rome" (hyphen is a
--               delimiter) — recall preserved for hyphenated forms.
-- REGION tokens keep substring ILIKE against the (clean, collision-free) region
-- column. Validated read-only vs prod: Australia Mar–May 2027 recall 111→107
-- (96%), Italy recall identical, Canada Nova-Scotia bleed 173→0.
--
-- Same 6-arg signature as 0032, so this is an in-place body replacement (no new
-- overload). SECURITY INVOKER / STABLE / search_path pinned, as before.

CREATE OR REPLACE FUNCTION public.match_region_itinerary_chunks(
  p_region_terms       TEXT[],
  p_port_terms         TEXT[],
  p_date_from          DATE,
  p_date_to            DATE,
  p_origin_port_terms  TEXT[] DEFAULT '{}',
  p_limit              INTEGER DEFAULT 12
)
RETURNS TABLE (
  related_chunk_id UUID,
  first_departure  DATE
)
LANGUAGE plpgsql
STABLE
SET search_path = 'public'
AS $$
BEGIN
  RETURN QUERY
  WITH matched AS (
    SELECT
      it.related_chunk_id    AS chunk_id,
      MIN(it.departure_date) AS first_departure
    FROM public.itineraries it
    WHERE it.related_chunk_id IS NOT NULL
      AND it.departure_date >= p_date_from
      AND it.departure_date <= p_date_to
      -- Destination match: region term (substring on region col) OR port term
      -- (segment-exact on departure_port / any port_of_call).
      AND (
        EXISTS (
          SELECT 1 FROM unnest(p_region_terms) rt
          WHERE it.region ILIKE ('%' || rt || '%')
        )
        OR EXISTS (
          SELECT 1
          FROM regexp_split_to_table(it.departure_port, '\s*[,-]\s*') seg
          CROSS JOIN unnest(p_port_terms) pt
          WHERE lower(btrim(seg)) = lower(pt)
        )
        OR EXISTS (
          SELECT 1
          FROM unnest(it.ports_of_call) poc
          CROSS JOIN LATERAL regexp_split_to_table(poc, '\s*[,-]\s*') seg
          CROSS JOIN unnest(p_port_terms) pt
          WHERE lower(btrim(seg)) = lower(pt)
        )
      )
      -- Optional ORIGIN constraint: departure_port segment equals an origin term.
      AND (
        coalesce(array_length(p_origin_port_terms, 1), 0) = 0
        OR EXISTS (
          SELECT 1
          FROM regexp_split_to_table(it.departure_port, '\s*[,-]\s*') seg
          CROSS JOIN unnest(p_origin_port_terms) ot
          WHERE lower(btrim(seg)) = lower(ot)
        )
      )
    GROUP BY it.related_chunk_id
  )
  SELECT m.chunk_id, m.first_departure
  FROM matched m
  ORDER BY m.first_departure ASC
  LIMIT GREATEST(p_limit, 1);
END;
$$;
