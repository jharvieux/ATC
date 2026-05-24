-- BP35 §33.4 — itineraries reference table.
--
-- Structured itinerary records ingested from CruiseMapper via Apify on a
-- monthly cadence (BP35 Inngest job). One row per (cruise_line, ship,
-- departure_date, departure_port) — re-ingest the same monthly actor run
-- upserts in place.
--
-- Lives in `public.` schema not `rag.` per repo convention (D-069); the
-- spec's `rag.itineraries` namespace is presentational.
--
-- RLS: deliberately disabled. Service-role only write path (BP35 RAG
-- ingest endpoint); read path is the chunked text already in
-- knowledge_chunks. Listed in apps/rag/db/rls-exceptions.txt.

CREATE TABLE public.itineraries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cruise_line       TEXT NOT NULL,
  ship              TEXT NOT NULL,
  departure_date    DATE NOT NULL,
  departure_port    TEXT NOT NULL,
  duration_nights   INTEGER NOT NULL CHECK (duration_nights > 0),
  ports_of_call     TEXT[] NOT NULL DEFAULT '{}',
  region            TEXT NULL,           -- e.g., 'caribbean' / 'alaska' — nullable when actor doesn't classify
  starting_price_usd NUMERIC(10,2) NULL, -- mirrors what flows to main app's pricing_cache; nullable when actor omits price
  source_url        TEXT NULL,
  content_hash      TEXT NOT NULL,       -- sha256 of the text doc fed to RAG — used by ingest path to skip unchanged
  related_chunk_id  UUID NULL REFERENCES public.knowledge_chunks(id) ON DELETE SET NULL,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (cruise_line, ship, departure_date, departure_port)
);

CREATE INDEX idx_itineraries_lookup
  ON public.itineraries (cruise_line, ship, departure_date);
CREATE INDEX idx_itineraries_region
  ON public.itineraries (region) WHERE region IS NOT NULL;
