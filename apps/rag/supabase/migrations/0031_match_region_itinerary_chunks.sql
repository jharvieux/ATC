-- 0031 — match_region_itinerary_chunks RPC: region/area + date-window sailing lookup.
--
-- The chat retrieval path has structured lookups for an exact ship+date
-- (#826 itinerary_lookup) and a named departure port+date (port_lookup), but no
-- way to enumerate sailings for a REGION/AREA ("Australia", "Caribbean") over a
-- date window when the customer names neither a ship nor a single port. Vector
-- search can't reliably enumerate sailings across the ~23K-row itinerary corpus,
-- so before this the concierge had no grounded sailing data for an open
-- "what sails Australia next spring?" query and fell back to a stub tool.
--
-- Why match BOTH region terms AND port terms: itineraries.region is unset on a
-- large share of rows (e.g. ~96% of Australian-port sailings carry NULL region),
-- so a region-column match alone misses most inventory. The caller (main app)
-- expands a named area to its region synonyms AND its major cruise ports; this
-- function matches a row if ANY region term hits itineraries.region OR ANY port
-- term hits departure_port OR any element of ports_of_call. unnest() over a NULL
-- or empty term array yields no rows, so an empty set simply contributes no
-- match (the caller guarantees at least one non-empty set).
--
-- Returns one row per related_chunk_id (the earliest matching departure carries
-- the row), ordered by that departure and capped, so the caller boosts the
-- nearest-term sailings. Real chunk ids keep the §6.10 feedback loop intact;
-- the caller re-fetches the chunk bodies with the same freshness + two-layer
-- tenant-isolation gates the other structured lookups use.
--
-- SECURITY INVOKER (default): called by the service_role connection, which has
-- EXECUTE via the public-schema default privileges set in 0025. STABLE: reads
-- only. search_path pinned to 'public' (mirrors match_knowledge_chunks, D-185).

-- NOTE: no cruise_line filter. itineraries.cruise_line stores line CODES (RCL,
-- CEL, NCL…), which would not ILIKE-match the full line names the entity
-- extractor produces ("Royal Caribbean") — a name filter would silently match
-- nothing. The model filters by line over the returned sailings instead.
CREATE OR REPLACE FUNCTION public.match_region_itinerary_chunks(
  p_region_terms TEXT[],
  p_port_terms   TEXT[],
  p_date_from    DATE,
  p_date_to      DATE,
  p_limit        INTEGER DEFAULT 12
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
    GROUP BY it.related_chunk_id
  )
  SELECT m.chunk_id, m.first_departure
  FROM matched m
  ORDER BY m.first_departure ASC
  LIMIT GREATEST(p_limit, 1);
END;
$$;
