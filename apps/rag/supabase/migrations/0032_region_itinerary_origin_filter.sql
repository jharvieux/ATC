-- 0032 — add an optional ORIGIN constraint to match_region_itinerary_chunks.
--
-- 0031 matched a region/area + date window against region OR departure_port OR
-- ports_of_call. For "from the US to Australia" that over-returns: a round-trip
-- Sydney sailing "visits Australia" and matches, even though it doesn't start in
-- the US. This adds p_origin_port_terms — when non-empty, the row's departure_port
-- must ILIKE one of those terms (the caller expands "the US" to its major
-- embarkation ports). Empty array = no origin constraint (0031 behaviour).
--
-- CREATE OR REPLACE with the new signature (extra param). 0031 must be applied
-- first (or this migration alone, since it is a complete definition). SECURITY
-- INVOKER / STABLE / search_path pinned, as before.

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
      it.related_chunk_id          AS chunk_id,
      MIN(it.departure_date)       AS first_departure
    FROM public.itineraries it
    WHERE it.related_chunk_id IS NOT NULL
      AND it.departure_date >= p_date_from
      AND it.departure_date <= p_date_to
      -- Destination match: region terms OR port terms hit region / departure_port /
      -- any port_of_call.
      AND (
        EXISTS (
          SELECT 1 FROM unnest(p_region_terms) rt
          WHERE it.region ILIKE ('%' || rt || '%')
        )
        OR EXISTS (
          SELECT 1 FROM unnest(p_port_terms) pt
          WHERE it.departure_port ILIKE ('%' || pt || '%')
        )
        OR EXISTS (
          SELECT 1
          FROM unnest(it.ports_of_call) poc
          CROSS JOIN unnest(p_port_terms) pt
          WHERE poc ILIKE ('%' || pt || '%')
        )
      )
      -- Optional ORIGIN constraint: when origin terms are supplied, the sailing
      -- must DEPART from one of them. unnest of an empty array yields no rows, so
      -- the COUNT guard makes an empty set mean "no constraint".
      AND (
        coalesce(array_length(p_origin_port_terms, 1), 0) = 0
        OR EXISTS (
          SELECT 1 FROM unnest(p_origin_port_terms) ot
          WHERE it.departure_port ILIKE ('%' || ot || '%')
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
