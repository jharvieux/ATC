-- #485 follow-up §33.4 — add per-day itinerary breakdown column.
--
-- day_by_day stores the full ParsedSailingDay[] array from the DIY sailing
-- parser. It is NULL for rows ingested via the legacy Apify path (which had
-- no per-day data). Downstream uses: sea-day weather interpolation (#486),
-- region classification (#486), destination image selection (#487).

ALTER TABLE public.itineraries
  ADD COLUMN IF NOT EXISTS day_by_day JSONB NULL;

COMMENT ON COLUMN public.itineraries.day_by_day IS
  'Per-day itinerary [{day_number,date,port_name,arrival_time,departure_time}]. NULL for Apify-sourced rows.';
